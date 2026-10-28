// Author: HyeonMo Gu
// Created: 2026-10-27

// Guardrail for the investigation agent. Pure function: it judges the agent's proposal by the tool
// results the agent gathered, never by the agent's own claims, and keeps the more conservative answer.
import type { CompareResult, Label } from "../tools/types";
import { decide, type Candidate, type Comparison, type DecideInput, type Decision } from "./decide";

export type Proposal = {
  label: Exclude<Label, "NEEDS_INFO">;
  incident_id: string | null;
  confidence: number;
  evidence_refs: string[];
  rationale: string;
};

/** One recorded agent tool call; `data` is the tool's validated output. */
export type GuardStep = { ref: string; tool: string; ok: boolean; args: unknown; data: unknown };

export type GuardInput = {
  proposal: Proposal;
  steps: GuardStep[];
  base: DecideInput; // the fast path's input, with the report's latest observed time and asked flag
  incidents: Record<string, Candidate>; // current facts for incidents the proposal or steps mention
};

export type GuardRule = "G1" | "G2" | "G3" | "G4";

export type GuardResult = {
  passed: boolean; // the final answer is the proposal (label and incident)
  final_label: Label;
  final_incident_id: string | null;
  decide_label: Label; // decide() on the merged facts, for transparency
  blocked_rules: GuardRule[];
};

// Every linked label names an incident, so every one needs same-asset evidence for it: a recurrence
// pinned on the wrong parent is its own error, however cautious the label.
const LINKED: ReadonlySet<Label> = new Set(["DUPLICATE", "LATE_REPORT", "POSSIBLE_RECURRENCE", "ALREADY_RESOLVED"]);
const NEEDS_OPEN: ReadonlySet<Label> = new Set(["DUPLICATE"]);
// Higher is more conservative: when the agent and the rules disagree, the higher one stands.
export const CAUTION: Record<Label, number> = {
  HUMAN_REVIEW: 6,
  NEEDS_INFO: 6,
  POSSIBLE_RECURRENCE: 5,
  NEW: 4,
  DUPLICATE: 3,
  LATE_REPORT: 2,
  ALREADY_RESOLVED: 1,
};

type CompareData = CompareResult & { candidate_incident_id: string; mode: "full" | "crops" };
type CompareArgs = { new_image_id: string; candidate_image_id: string; mode: "full" | "crops" };
type SearchData = { incidents: Array<Omit<Candidate, "incident_id"> & { incident_id: string }> };

export function guard(input: GuardInput): GuardResult {
  const { proposal, steps, base } = input;
  const okSteps = new Map(steps.filter((s) => s.ok).map((s) => [s.ref, s]));
  const blocked: GuardRule[] = [];

  // G3: every cited ref is a successful tool call; only HUMAN_REVIEW may cite nothing.
  const citesUnknown = proposal.evidence_refs.some((ref) => !okSteps.has(ref));
  if (citesUnknown || (proposal.label !== "HUMAN_REVIEW" && proposal.evidence_refs.length === 0)) blocked.push("G3");

  const merged = mergeFacts(input);
  const decided = decide(merged);
  const decideLabel = decided.label;
  const verdict = (final_label: Label, final_incident_id: string | null, rules: GuardRule[]): GuardResult => ({
    passed: rules.length === 0 && final_label === proposal.label && final_incident_id === proposal.incident_id,
    final_label,
    final_incident_id,
    decide_label: decideLabel,
    blocked_rules: rules,
  });
  // Without valid citations nothing below can be checked.
  if (blocked.length > 0) return verdict("HUMAN_REVIEW", null, blocked);

  const incident = proposal.incident_id ? (input.incidents[proposal.incident_id] ?? merged.candidates.find((c) => c.incident_id === proposal.incident_id)) : undefined;
  const cited = proposal.evidence_refs.flatMap((ref) => {
    const step = okSteps.get(ref);
    return step?.tool === "compare_images" ? [step.data as CompareData] : [];
  });
  const citedForIncident = cited.filter((c) => c.candidate_incident_id === proposal.incident_id);

  // G1: linked labels name a known incident in the right state and cite a confident same-asset comparison with it.
  if (LINKED.has(proposal.label)) {
    const confident = citedForIncident.some((c) => c.asset_match.verdict === "same" && c.asset_match.confidence >= base.config.match_conf);
    const open = incident?.status === "open" || incident?.status === "in_progress";
    const wrongState = NEEDS_OPEN.has(proposal.label) ? !open : open; // the other linked labels need a resolved incident
    if (!incident || !confident || wrongState) blocked.push("G1");
  }

  // G2: a problem seen after a recorded fix is never folded into the old incident.
  if ((proposal.label === "DUPLICATE" || proposal.label === "LATE_REPORT") && incident?.resolved_at) {
    const afterFix = Date.parse(base.report.observed_at) > Date.parse(incident.resolved_at) + base.config.time_margin_h * 3_600_000;
    if (afterFix && citedForIncident.some((c) => c.damage.new_damage_present)) blocked.push("G2");
  }

  if (blocked.length > 0) return verdict("HUMAN_REVIEW", null, blocked);

  // G4: the rules rerun on everything the agent found; the more conservative answer stands.
  const ruleLabel: Label = decideLabel === "NEEDS_INFO" ? "HUMAN_REVIEW" : decideLabel;
  if (ruleLabel === proposal.label) {
    if (LINKED.has(ruleLabel) && decided.incident_id !== proposal.incident_id) return verdict("HUMAN_REVIEW", null, ["G4"]);
    return verdict(proposal.label, proposal.incident_id, []);
  }
  // A more cautious label stands, but not on a different incident than the one the rules point at.
  if (CAUTION[proposal.label] > CAUTION[ruleLabel]) {
    if (LINKED.has(proposal.label) && LINKED.has(ruleLabel) && decided.incident_id !== proposal.incident_id) return verdict("HUMAN_REVIEW", null, ["G4"]);
    return verdict(proposal.label, proposal.incident_id, []);
  }
  return verdict(ruleLabel, ruleLabel === "HUMAN_REVIEW" ? null : decided.incident_id, ["G4"]);
}

/** The rules rerun on the fast path's facts plus everything the agent's tools returned, whatever it proposed. */
export function recheck(input: Omit<GuardInput, "proposal">): Decision {
  return decide(mergeFacts(input));
}

// Everything the agent learned joins the fast path's facts: incidents it found, comparisons it ran,
// and the current state of every incident involved.
function mergeFacts({ steps, base, incidents }: Omit<GuardInput, "proposal">): DecideInput {
  const candidates = new Map(base.candidates.map((c) => [c.incident_id, c]));
  const comparisons: Comparison[] = [...base.comparisons];
  for (const step of steps.filter((s) => s.ok)) {
    if (step.tool === "search_incidents") {
      for (const i of (step.data as SearchData).incidents) {
        if (!candidates.has(i.incident_id)) {
          candidates.set(i.incident_id, {
            incident_id: i.incident_id,
            status: i.status,
            created_at: i.created_at,
            resolved_at: i.resolved_at,
            recurrence_of: i.recurrence_of,
            distance_m: i.distance_m,
          });
        }
      }
    }
    if (step.tool === "compare_images") {
      const { candidate_incident_id, mode, ...result } = step.data as CompareData;
      const args = step.args as CompareArgs;
      comparisons.push({
        incident_id: candidate_incident_id,
        stage: mode === "crops" ? 2 : 1,
        new_image_id: args.new_image_id,
        candidate_image_id: args.candidate_image_id,
        result,
        ...(args.mode === "crops" && mode === "full" ? { fallback: true } : {}),
      });
    }
  }
  for (const [id, facts] of Object.entries(incidents)) {
    if (candidates.has(id) || comparisons.some((c) => c.incident_id === id)) candidates.set(id, facts);
  }
  return { ...base, candidates: [...candidates.values()], comparisons };
}
