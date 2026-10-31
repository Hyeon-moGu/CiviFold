// Author: HyeonMo Gu
// Created: 2026-10-28

// The verification agent's tool calls in staff words, and what a finished run means for the suggestion.
// Shared by the live progress panel and the stored run, so both read the same. Relative imports keep it
// loadable by vitest, which has no path aliases.
import type { AgentStep } from "@/lib/agent/run";
import type { Label } from "@/lib/tools/types";
import { pct, readable, VERDICT_TEXT } from "../../../_ui/console";
import { LABEL_TEXT } from "../../../_ui/labels";

export type StepView = Pick<AgentStep, "step" | "ref" | "tool" | "ok" | "error" | "args" | "data">;

export const TOOL_TEXT: Record<string, string> = {
  search_incidents: "Searched nearby",
  get_incident_timeline: "Read the incident's history",
  segment_object: "Cut out the object (SAM 3.1)",
  compare_images: "Compared photos",
  ask_resident: "Asked the resident",
  propose_decision: "Proposed a decision",
  write_brief: "Wrote the brief",
};

export const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

export function summarize(s: StepView): string {
  if (!s.ok) return s.error ?? "failed";
  const d = s.data as Record<string, unknown>;
  switch (s.tool) {
    case "search_incidents":
      return `${plural((d.incidents as unknown[]).length, "incident")} within ${(s.args as { radius_m: number }).radius_m} m`;
    case "get_incident_timeline":
      return `${plural((d.events as unknown[]).length, "event")}, ${plural((d.photos as unknown[]).length, "photo")}`;
    case "segment_object":
      return d.found ? `found ${d.instances} "${(s.args as { noun_phrase: string }).noun_phrase}"` : "nothing found";
    case "compare_images": {
      const c = compared(s)!;
      return `${VERDICT_TEXT[c.verdict] ?? c.verdict} ${pct(c.confidence)} vs ${c.incident_id} (${c.mode})`;
    }
    case "ask_resident":
      return `asked: ${(s.args as { question: string }).question}`;
    case "propose_decision": {
      const a = s.args as { label: Label; incident_id: string | null };
      return `${LABEL_TEXT[a.label]}${a.incident_id ? ` → ${a.incident_id}` : ""}`;
    }
    case "write_brief": {
      const b = d as { kept: number; dropped: number };
      return `${plural(b.kept, "item")} with evidence${b.dropped ? `, ${b.dropped} deleted without` : ""}`;
    }
    default:
      return "done";
  }
}

function compared(s: StepView) {
  if (!s.ok || s.tool !== "compare_images") return null;
  const d = s.data as { asset_match: { verdict: string; confidence: number }; candidate_incident_id: string; mode: string };
  return { ...d.asset_match, incident_id: d.candidate_incident_id, mode: d.mode === "crops" ? "cut-out" : "whole photo" };
}

export type Verdict = {
  kind: "confirmed" | "unchanged" | "against" | "blocked" | "unsettled";
  title: string;
  detail: string | null;
  against: string[]; // comparisons that go against the suggestion or leave it unclear
  agree: string[]; // comparisons that back it
  checks: number; // tool calls that returned a result, the proposal not counted
};

/**
 * What a staff-requested run says about the suggestion it checked. A suggestion that stayed is not by that
 * fact backed by the run: "confirmed" needs a finished run whose proposal the guardrail passed, at least one
 * comparison finding the suggested incident the same, and nothing against it. A comparison backs a link when
 * it finds the suggested incident the same, or rules out another incident; it goes against it when the
 * suggested incident looks different or unclear, or another incident looks the same. Evidence against is
 * shown whether or not the answer changed.
 */
export function verdictOf(run: {
  status: string;
  guard: { passed: boolean; blocked_rules: string[] } | null;
  steps: StepView[];
  before: { label: Label; incident_id: string | null };
  after: { label: Label; incident_id: string | null; reason?: string };
}): Verdict {
  const { before, after, steps } = run;
  const against: string[] = [];
  const agree: string[] = [];
  let backed = false;
  for (const s of steps) {
    const c = compared(s);
    if (!c) continue;
    const line = `${c.mode === "cut-out" ? "Cut-out" : "Whole photo"} vs ${c.incident_id}: ${VERDICT_TEXT[c.verdict] ?? c.verdict}, model confidence ${pct(c.confidence)}`;
    const suggested = c.incident_id === before.incident_id;
    if (suggested && c.verdict === "same") backed = true;
    if (suggested ? c.verdict === "same" : c.verdict === "different") agree.push(suggested ? line : `${line} (ruled out)`);
    else if (suggested || c.verdict === "same") against.push(line);
  }
  const checks = steps.filter((s) => s.ok && s.tool !== "propose_decision").length;
  const changed = after.label !== before.label || after.incident_id !== before.incident_id;
  const now = LABEL_TEXT[after.label];
  const reason = after.reason ? readable(after.reason) : null;
  const base = { against, agree, checks };
  if (against.length) {
    return changed
      ? { ...base, kind: "against", title: `Evidence against it: now ${now}`, detail: reason }
      : { ...base, kind: "against", title: `Suggestion kept, with evidence against it`, detail: "The rules kept the suggestion, but some comparisons went against it or were unclear. Look at them before you choose." };
  }
  if (run.status === "failed" || run.status === "budget_exceeded") {
    return {
      ...base,
      kind: "unsettled",
      title: `Stopped after ${plural(checks, "check")}`,
      detail: changed ? reason : "Nothing it found went against the suggestion, but the run did not finish. Decide from the evidence, or run it again.",
    };
  }
  if (run.status === "blocked") {
    const rules = run.guard?.blocked_rules.join(", ") ?? "";
    return {
      ...base,
      kind: "blocked",
      title: "Verification proposal blocked",
      detail: `The guardrail did not accept the agent's proposal${rules ? ` (${rules})` : ""}, so the run did not back the suggestion.${changed && reason ? ` ${reason}` : " The suggestion is the fast path's, unchecked."}`,
    };
  }
  if (changed) return { ...base, kind: "unsettled", title: `Could not settle it: now ${now}`, detail: reason };
  if (run.status === "proposed" && run.guard?.passed && backed) {
    return { ...base, kind: "confirmed", title: `Confirmed by the checks: ${LABEL_TEXT[before.label]}`, detail: `${plural(checks, "check")}, ${plural(agree.length, "comparison")} backing it, none against.` };
  }
  return {
    ...base,
    kind: "unchanged",
    title: "Suggestion unchanged",
    detail: `${plural(checks, "check")}, none against it, but none compared the report with ${before.incident_id ?? "the incident"} and found it the same. The run did not back it on its own.`,
  };
}
