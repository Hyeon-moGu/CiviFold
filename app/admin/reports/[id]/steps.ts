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

// A tool input its schema refused arrives as zod's list of issues, in JSON: name the fields instead.
function refusedFields(error: string): string | null {
  if (!error.trimStart().startsWith("[")) return null;
  try {
    const issues = JSON.parse(error) as Array<{ path?: unknown[] }>;
    if (!Array.isArray(issues) || issues.length === 0) return null;
    const fields = [...new Set(issues.map((i) => (Array.isArray(i.path) && i.path.length ? i.path.join(".").replace(/_m$/, "").replaceAll("_", " ") : "input")))];
    return `rejected an invalid ${fields.join(" and ")}; the agent went on`;
  } catch {
    return null;
  }
}

export function summarize(s: StepView): string {
  if (!s.ok) {
    // An id the agent made up or misread: the tool refused it, and the run went on.
    if (s.error && /^Unknown (incident|image|photo|report)/i.test(s.error)) return "asked for something not on file; the agent went on";
    return (s.error && refusedFields(s.error)) ?? s.error ?? "failed";
  }
  const d = s.data as Record<string, unknown>;
  switch (s.tool) {
    case "search_incidents":
      return `${plural((d.incidents as unknown[]).length, "incident")} within ${(s.args as { radius_m: number }).radius_m} m`;
    case "get_incident_timeline":
      return `${plural((d.events as unknown[]).length, "event")}, ${plural((d.photos as unknown[]).length, "photo")}`;
    case "segment_object":
      return d.found ? `found ${d.instances} ${Number(d.instances) === 1 ? "match" : "matches"} for “${(s.args as { noun_phrase: string }).noun_phrase}”` : "nothing found";
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
  const d = s.data as {
    asset_match: { verdict: string; confidence: number };
    damage?: { same_damage_signature: string };
    candidate_incident_id: string;
    mode: string;
  };
  const image = (s.args as { candidate_image_id?: string } | null)?.candidate_image_id ?? null;
  return { ...d.asset_match, problem: d.damage?.same_damage_signature, incident_id: d.candidate_incident_id, image, mode: d.mode === "crops" ? "cut-out" : "whole photo" };
}

export type Verdict = {
  kind: "confirmed" | "unchanged" | "against" | "blocked" | "unsettled";
  title: string;
  detail: string | null;
  against: string[]; // comparisons that go against the suggestion or leave it unclear
  agree: string[]; // comparisons that back it
  photos: Record<string, string>; // line -> the incident photo it compared with
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
  incidentNames?: Record<string, string>; // incident id -> title, so the lines name what was compared
}): Verdict {
  const { before, after, steps } = run;
  const nameOf = (id: string) => (run.incidentNames?.[id] ? `the ${run.incidentNames[id]}` : id);
  const against: string[] = [];
  const agree: string[] = [];
  const photos: Record<string, string> = {};
  const add = (list: string[], line: string, image: string | null) => {
    list.push(line);
    if (image) photos[line] = image;
  };
  let backed = false;
  let alsoMatches = false;
  for (const s of steps) {
    const c = compared(s);
    if (!c) continue;
    const line = `${c.mode === "cut-out" ? "Cut-out" : "Whole photo"} vs ${nameOf(c.incident_id)}: ${VERDICT_TEXT[c.verdict] ?? c.verdict}, model confidence ${pct(c.confidence)}`;
    const suggested = c.incident_id === before.incident_id;
    if (suggested && c.verdict === "same") backed = true;
    if (suggested ? c.verdict === "same" : c.verdict === "different") add(agree, suggested ? line : `${line} (ruled out)`, c.image);
    else if (suggested) add(against, line, c.image);
    // The same fixture with a different problem (a later recurrence of it, say) is not this report's incident.
    else if (c.verdict === "same" && c.problem === "different") add(agree, `${line}, a different problem (ruled out)`, c.image);
    // Another incident of the same fixture and problem: the merge may target the wrong one.
    else if (c.verdict === "same") {
      alsoMatches = true;
      add(against, `This photo also matches ${nameOf(c.incident_id)} (${c.mode}, model confidence ${pct(c.confidence)})`, c.image);
    }
  }
  const checks = steps.filter((s) => s.ok && s.tool !== "propose_decision").length;
  const changed = after.label !== before.label || after.incident_id !== before.incident_id;
  const now = LABEL_TEXT[after.label];
  const reason = after.reason ? readable(after.reason) : null;
  const base = { against, agree, photos, checks };
  if (against.length) {
    return changed
      ? { ...base, kind: "against", title: `Evidence against it: now ${now}`, detail: reason }
      : {
          ...base,
          kind: "against",
          title: `Suggestion kept, with evidence against it`,
          detail: alsoMatches
            ? "The rules kept the suggestion, but the agent found another incident this photo matches. Check which one the report belongs to before you approve."
            : "The rules kept the suggestion, but some comparisons went against it or were unclear. Look at them before you choose.",
        };
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
    // The guardrail wants a proposal to cite a confident comparison with the incident it names; a proposal that
    // falls short is left out, and the answer is the rules' on what the agent found.
    return {
      ...base,
      kind: "blocked",
      title: changed ? `The check did not settle it: now ${now}` : "No evidence against it, but the check fell short",
      detail: changed && reason
        ? reason
        : "The agent found nothing against the suggestion, but its proposal did not cite a confident comparison with the incident, so it does not count as confirmed. The suggestion stays as the fast path made it.",
    };
  }
  if (changed) return { ...base, kind: "unsettled", title: `Could not settle it: now ${now}`, detail: reason };
  if (run.status === "proposed" && run.guard?.passed && backed) {
    const ruledOut = agree.filter((line) => line.endsWith("(ruled out)")).length;
    const matched = agree.length - ruledOut;
    return {
      ...base,
      kind: "confirmed",
      title: `Confirmed by the checks: ${LABEL_TEXT[before.label]}`,
      detail: `The agent ran ${plural(checks, "check")} before proposing: ${plural(matched, "comparison")} ${matched === 1 ? "matches" : "match"}${ruledOut ? `, ${ruledOut} ${ruledOut === 1 ? "rules" : "rule"} out look-alikes` : ""}, and none ${checks === 1 ? "goes" : "go"} against it.`,
    };
  }
  return {
    ...base,
    kind: "unchanged",
    title: "Suggestion unchanged",
    detail: `${plural(checks, "check")}, none against it, but none compared the report with ${before.incident_id ?? "the incident"} and found it the same. The run did not back it on its own.`,
  };
}
