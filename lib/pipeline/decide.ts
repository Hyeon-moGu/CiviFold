// Author: HyeonMo Gu
// Created: 2026-10-27

// Decision engine. Pure function: no I/O, no model calls, no clock.
// The model judges what the photos show; these rules judge time and incident state.
// Rule ids (R0–R7t, P1) are recorded in every decision and mirrored in decide.test.ts.
import type { CompareResult, IncidentStatus, Label, MissingItem } from "../tools/types";

export type DecideConfig = {
  match_conf: number;
  no_match_conf: number;
  time_margin_h: number;
  sig_uncertain_factor: number;
};

export type Candidate = {
  incident_id: string;
  status: IncidentStatus;
  created_at: string;
  resolved_at: string | null;
  recurrence_of: string | null;
  distance_m: number;
};

export type Comparison = {
  incident_id: string;
  stage: 1 | 2; // 1 = full photos, 2 = SAM crops
  candidate_image_id: string;
  result: CompareResult | null; // null = the call failed
};

export type DecideInput = {
  report: { observed_at: string; already_asked: boolean };
  triage: { image_quality: "ok" | "blurry" | "object_not_visible" | "too_far" };
  candidates: Candidate[];
  comparisons: Comparison[];
  config: DecideConfig;
};

export type Reason = { rule_id: string; text: string };

export type Decision = {
  label: Label;
  incident_id: string | null;
  rule_id: string; // the rule that produced the final label
  reasons: Reason[]; // every rule that fired, in order
  confidence: number;
  missing_info: MissingItem[];
};

type Assessed =
  | { candidate: Candidate; verdict: "MATCH" | "NO_MATCH"; result: CompareResult }
  | { candidate: Candidate; verdict: "UNCERTAIN"; result: CompareResult | null };
type Matched = Extract<Assessed, { verdict: "MATCH" | "NO_MATCH" }>;

const HOUR_MS = 3_600_000;

export function decide(input: DecideInput): Decision {
  const decision = applyRules(input);
  // P1: never ask the resident twice.
  if (decision.label !== "NEEDS_INFO" || !input.report.already_asked) return decision;
  return {
    ...decision,
    label: "HUMAN_REVIEW",
    rule_id: "P1",
    reasons: [...decision.reasons, { rule_id: "P1", text: "The resident was already asked once, so staff should review." }],
    missing_info: [],
  };
}

function applyRules(input: DecideInput): Decision {
  const { triage, candidates, config } = input;

  // R0: a photo with nothing to compare stops here. A distant photo still goes on to matching:
  // it can identify the asset, and R7t asks for a close-up only where damage detail decides the label.
  if (triage.image_quality === "blurry" || triage.image_quality === "object_not_visible") {
    const item = triage.image_quality === "object_not_visible" ? "wider_context" : "close_up";
    return needsInfo("R0", `Photo quality is "${triage.image_quality}".`, [item], 0);
  }

  // R1
  if (candidates.length === 0) return decision("NEW", null, "R1", "No existing incident nearby.", 1);

  // R2: classify each candidate from its aggregated comparison.
  const assessed = candidates.map((c) => assess(c, input.comparisons, config));
  const matches = assessed.filter((a): a is Matched => a.verdict === "MATCH");
  const noMatches = assessed.filter((a): a is Matched => a.verdict === "NO_MATCH");

  // R3
  if (noMatches.length === assessed.length) {
    const confidence = Math.min(...noMatches.map((a) => a.result.asset_match.confidence));
    return decision("NEW", null, "R3", `All ${assessed.length} nearby incidents show a different asset.`, confidence);
  }

  // R5: nothing matches, at least one candidate is uncertain.
  if (matches.length === 0) {
    const ids = assessed.filter((a) => a.verdict === "UNCERTAIN").map((a) => a.candidate.incident_id);
    if (input.report.already_asked) {
      return decision("HUMAN_REVIEW", null, "R5", `Still uncertain about ${ids.join(", ")} after asking once.`, 0);
    }
    const missing = [...new Set(assessed.flatMap((a) => (a.verdict === "UNCERTAIN" ? (a.result?.missing_info ?? []) : [])))];
    return needsInfo("R5", `Not sure whether this is the same asset as ${ids.join(", ")}.`, missing.length > 0 ? missing : ["wider_context"], 0);
  }

  // R4 / R4c: several incidents match.
  const observedMs = Date.parse(input.report.observed_at);
  let best = matches[0]!;
  const chainReasons: Reason[] = [];
  if (matches.length > 1) {
    const ids = matches.map((m) => m.candidate.incident_id).join(", ");
    if (!isOneChain(matches.map((m) => m.candidate), candidates)) {
      return decision("HUMAN_REVIEW", null, "R4", `Matches several unrelated incidents: ${ids}.`, 0);
    }
    best = pickInChain(matches, observedMs);
    chainReasons.push({
      rule_id: "R4c",
      text: `${ids} are one recurrence chain; ${best.candidate.incident_id} covers the observation time.`,
    });
  }

  const tooFar = triage.image_quality === "too_far";
  const d = isOpen(best.candidate.status) ? openRules(best, config) : resolvedRules(best, observedMs, tooFar, config);
  return { ...d, reasons: [...chainReasons, ...d.reasons] };
}

// Per incident: crop comparisons (stage 2) replace full-photo ones; among those, the highest
// asset confidence wins. Failed calls count as no result.
function assess(candidate: Candidate, comparisons: Comparison[], config: DecideConfig): Assessed {
  const own = comparisons
    .filter((c) => c.incident_id === candidate.incident_id)
    .flatMap((c) => (c.result === null ? [] : [{ stage: c.stage, result: c.result }]));
  const stage2 = own.filter((c) => c.stage === 2);
  const pool = stage2.length > 0 ? stage2 : own;
  const result = pool.reduce<CompareResult | null>(
    (top, c) => (top === null || c.result.asset_match.confidence > top.asset_match.confidence ? c.result : top),
    null,
  );
  if (result === null) return { candidate, verdict: "UNCERTAIN", result };
  const { verdict, confidence } = result.asset_match;
  if (verdict === "same" && confidence >= config.match_conf) return { candidate, verdict: "MATCH", result };
  if (verdict === "different" && confidence >= config.no_match_conf) return { candidate, verdict: "NO_MATCH", result };
  return { candidate, verdict: "UNCERTAIN", result };
}

// True when every pair of incidents is linked through recurrence_of (one is an ancestor of the other).
function isOneChain(chain: Candidate[], all: Candidate[]): boolean {
  const byId = new Map(all.map((c) => [c.incident_id, c]));
  const ancestors = (c: Candidate) => {
    const seen = new Set<string>();
    for (let id = c.recurrence_of; id !== null && !seen.has(id); id = byId.get(id)?.recurrence_of ?? null) seen.add(id);
    return seen;
  };
  const lineage = new Map(chain.map((c) => [c.incident_id, ancestors(c)]));
  return chain.every((a) =>
    chain.every((b) => a === b || lineage.get(a.incident_id)!.has(b.incident_id) || lineage.get(b.incident_id)!.has(a.incident_id)),
  );
}

// The incident whose [created_at, resolved_at) contains the observation; otherwise the most recent one.
function pickInChain(matches: Matched[], observedMs: number): Matched {
  const covering = matches.filter(
    ({ candidate: c }) =>
      Date.parse(c.created_at) <= observedMs && (c.resolved_at === null || observedMs < Date.parse(c.resolved_at)),
  );
  const pool = covering.length > 0 ? covering : matches;
  return pool.reduce((a, b) => (Date.parse(b.candidate.created_at) > Date.parse(a.candidate.created_at) ? b : a));
}

// R6: the matched incident is still open.
function openRules(best: Matched, config: DecideConfig): Decision {
  const id = best.candidate.incident_id;
  const { new_damage_present: dmg, same_damage_signature: sig, repair_signs_in_new: rep } = best.result.damage;
  const conf = matchConfidence(best.result, config);
  const asset = `Same asset as ${id} (${best.result.asset_match.confidence.toFixed(2)})`;
  if (dmg && sig !== "different") return decision("DUPLICATE", id, "R6a", `${asset}, damage ${sig}, incident still open.`, conf);
  if (dmg) return decision("HUMAN_REVIEW", id, "R6b", `${asset}, but the damage differs from the open incident.`, conf);
  if (rep) return decision("HUMAN_REVIEW", id, "R6c", `${asset}, no damage and repair signs, yet the incident is open.`, conf);
  return needsInfo("R6d", `${asset}, but no damage is visible.`, ["close_up"], conf);
}

// R7: the matched incident was repaired. Δ = observed − resolved, with a ±margin of ambiguity.
function resolvedRules(best: Matched, observedMs: number, tooFar: boolean, config: DecideConfig): Decision {
  const c = best.candidate;
  const id = c.incident_id;
  const { new_damage_present: dmg, same_damage_signature: sig, repair_signs_in_new: rep } = best.result.damage;
  const conf = matchConfidence(best.result, config);
  if (c.resolved_at === null) {
    return decision("HUMAN_REVIEW", id, "R7h", `${id} is ${c.status} but has no repair time.`, conf);
  }
  const deltaMs = observedMs - Date.parse(c.resolved_at);
  const marginMs = config.time_margin_h * HOUR_MS;
  const when = `${Math.round(Math.abs(deltaMs) / HOUR_MS)}h ${deltaMs < 0 ? "before" : "after"} the repair of ${id}`;

  if (deltaMs < -marginMs) {
    if (sig !== "different") return decision("LATE_REPORT", id, "R7a", `Observed ${when}, damage ${sig}.`, conf);
    return decision("HUMAN_REVIEW", id, "R7b", `Observed ${when}, but the damage differs.`, conf);
  }
  if (deltaMs > marginMs) {
    // R7t: after a repair only damage detail separates recurrence from a repaired asset.
    if (tooFar) return needsInfo("R7t", `Observed ${when}, but the photo is too far to tell new damage from the repair.`, ["close_up"], conf);
    if (!dmg && rep) return decision("ALREADY_RESOLVED", id, "R7c", `Observed ${when}, shows the repair.`, conf);
    if (!dmg) return needsInfo("R7g", `Observed ${when}, but neither damage nor repair is visible.`, ["close_up"], conf);
    if (sig === "different") return decision("POSSIBLE_RECURRENCE", id, "R7d", `Observed ${when}, with new damage.`, conf);
    if (sig === "same" && !rep) {
      return needsInfo("R7e", `Observed ${when}, yet shows the original damage and no repair; the photo may be older.`, ["observed_time"], conf);
    }
    return decision("POSSIBLE_RECURRENCE", id, "R7f", `Observed ${when}, damage is back.`, conf);
  }
  return decision("HUMAN_REVIEW", id, "R7h", `Observed ${when}, within ±${config.time_margin_h}h.`, conf);
}

function isOpen(status: IncidentStatus): boolean {
  return status === "open" || status === "in_progress";
}

function matchConfidence(result: CompareResult, config: DecideConfig): number {
  const factor = result.damage.same_damage_signature === "uncertain" ? config.sig_uncertain_factor : 1;
  return round(result.asset_match.confidence * factor);
}

function round(x: number): number {
  return Math.round(x * 1000) / 1000;
}

function decision(label: Label, incidentId: string | null, ruleId: string, text: string, confidence: number): Decision {
  return { label, incident_id: incidentId, rule_id: ruleId, reasons: [{ rule_id: ruleId, text }], confidence, missing_info: [] };
}

function needsInfo(ruleId: string, text: string, missing: MissingItem[], confidence: number): Decision {
  return { ...decision("NEEDS_INFO", null, ruleId, text, confidence), missing_info: missing };
}
