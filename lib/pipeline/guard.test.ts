// Author: HyeonMo Gu
// Created: 2026-10-27

import { describe, expect, it } from "vitest";
import type { Label } from "../tools/types";
import { at, cand, cmp, deepFreeze, input, TEST_CONFIG } from "./__fixtures__/builders";
import type { Candidate, DecideInput } from "./decide";
import { guard, type GuardInput, type GuardResult, type GuardRule, type GuardStep, type Proposal } from "./guard";

const proposal = (label: Proposal["label"], incident_id: string | null, evidence_refs: string[]): Proposal => ({
  label,
  incident_id,
  confidence: 0.8,
  evidence_refs,
  rationale: "",
});

/** A compare_images step: `cmp` options plus the incident the server resolved and the mode. */
function compareStep(ref: string, incident: string, verdict: "same" | "different" | "uncertain", confidence: number, opts: Parameters<typeof cmp>[3] & { mode?: "full" | "crops" } = {}): GuardStep {
  const { mode = "crops", ...rest } = opts;
  const c = cmp(incident, verdict, confidence, rest);
  return {
    ref,
    tool: "compare_images",
    ok: true,
    args: { new_image_id: "img_new", candidate_image_id: `img_${incident}`, mode },
    data: { ...c.result, candidate_incident_id: incident, mode },
  };
}

const searchStep = (ref: string, found: Candidate[]): GuardStep => ({ ref, tool: "search_incidents", ok: true, args: {}, data: { incidents: found } });
const failedStep = (ref: string): GuardStep => ({ ref, tool: "compare_images", ok: false, args: {}, data: null });

// The fast path stopped: one open incident, a full-photo comparison it could not decide.
const unsure = () => input({ candidates: [cand("I1", "open")], comparisons: [cmp("I1", "uncertain", 0.5, { stage: 1 })] });

function g(p: Proposal, steps: GuardStep[], base: DecideInput = unsure(), extra: Candidate[] = []): GuardInput {
  const incidents = Object.fromEntries([...base.candidates, ...extra].map((c) => [c.incident_id, c]));
  return { proposal: p, steps, base, incidents };
}

type Expected = { label: Label; incident?: string | null; passed: boolean; blocked?: GuardRule[]; decide?: Label };
type Case = { id: string; desc: string; input: GuardInput; expected: Expected };
const c = (id: string, desc: string, i: GuardInput, expected: Expected): Case => ({ id, desc, input: i, expected });

const resolvedI1 = (observed: string) => input({ candidates: [cand("I1", "resolved")], observed, comparisons: [cmp("I1", "uncertain", 0.5, { stage: 1 })] });

const CASES: Case[] = [
  c("G-01", "human review always passes", g(proposal("HUMAN_REVIEW", null, []), []), { label: "HUMAN_REVIEW", passed: true }),
  c("G-02", "a proper duplicate", g(proposal("DUPLICATE", "I1", ["step_2"]), [compareStep("step_2", "I1", "same", 0.9)]), {
    label: "DUPLICATE",
    incident: "I1",
    passed: true,
  }),
  c("G-03", "cites a step that does not exist", g(proposal("DUPLICATE", "I1", ["step_9"]), [compareStep("step_2", "I1", "same", 0.9)]), {
    label: "HUMAN_REVIEW",
    passed: false,
    blocked: ["G3"],
  }),
  c("G-04", "cites a failed step", g(proposal("DUPLICATE", "I1", ["step_2"]), [failedStep("step_2")]), { label: "HUMAN_REVIEW", passed: false, blocked: ["G3"] }),
  c("G-04b", "links without citing anything", g(proposal("NEW", null, []), []), { label: "HUMAN_REVIEW", passed: false, blocked: ["G3"] }),
  c("G-05", "cites only a search", g(proposal("DUPLICATE", "I1", ["step_1"]), [searchStep("step_1", [cand("I1", "open")])]), {
    label: "HUMAN_REVIEW",
    passed: false,
    blocked: ["G1"],
  }),
  c("G-06", "cites a comparison with another incident", g(proposal("DUPLICATE", "I1", ["step_2"]), [compareStep("step_2", "I2", "same", 0.9)], unsure(), [cand("I2", "open")]), {
    label: "HUMAN_REVIEW",
    passed: false,
    blocked: ["G1"],
  }),
  c("G-07", "not confident enough", g(proposal("DUPLICATE", "I1", ["step_2"]), [compareStep("step_2", "I1", "same", 0.7)]), {
    label: "HUMAN_REVIEW",
    passed: false,
    blocked: ["G1"],
  }),
  c("G-08", "no incident id", g(proposal("DUPLICATE", null, ["step_2"]), [compareStep("step_2", "I1", "same", 0.9)]), {
    label: "HUMAN_REVIEW",
    passed: false,
    blocked: ["G1"],
  }),
  c("G-09", "recurrence of an open incident", g(proposal("POSSIBLE_RECURRENCE", "I1", ["step_2"]), [compareStep("step_2", "I1", "same", 0.9, { sig: "different" })]), {
    label: "HUMAN_REVIEW",
    passed: false,
    blocked: ["G1"],
  }),
  c(
    "G-10",
    "already resolved while the incident is open",
    g(proposal("ALREADY_RESOLVED", "I1", ["step_2"]), [compareStep("step_2", "I1", "same", 0.9, { dmg: false, rep: true })]),
    { label: "HUMAN_REVIEW", passed: false, blocked: ["G1"] },
  ),
  c(
    "G-11",
    "buries a recurrence as a duplicate",
    g(proposal("DUPLICATE", "I1", ["step_2"]), [compareStep("step_2", "I1", "same", 0.9)], resolvedI1(at("+3d"))),
    { label: "HUMAN_REVIEW", passed: false, blocked: ["G1", "G2"] },
  ),
  c(
    "G-12",
    "buries a recurrence as a late report",
    g(proposal("LATE_REPORT", "I1", ["step_2"]), [compareStep("step_2", "I1", "same", 0.9)], resolvedI1(at("+3d"))),
    { label: "HUMAN_REVIEW", passed: false, blocked: ["G2"] },
  ),
  c("G-13", "a proper late report", g(proposal("LATE_REPORT", "I1", ["step_2"]), [compareStep("step_2", "I1", "same", 0.9)], resolvedI1(at("-2d"))), {
    label: "LATE_REPORT",
    incident: "I1",
    passed: true,
  }),
  c(
    "G-14",
    "uses the observed time the resident corrected",
    g(proposal("LATE_REPORT", "I1", ["step_2"]), [compareStep("step_2", "I1", "same", 0.9)], { ...resolvedI1(at("-2d")), report: { observed_at: at("-2d"), already_asked: true } }),
    { label: "LATE_REPORT", incident: "I1", passed: true },
  ),
  c(
    "G-15",
    "an incident found by a wider search",
    g(
      proposal("DUPLICATE", "I3", ["step_1", "step_2"]),
      [searchStep("step_1", [cand("I3", "open", { distance_m: 95 })]), compareStep("step_2", "I3", "same", 0.9)],
      input(),
      [cand("I3", "open", { distance_m: 95 })],
    ),
    { label: "DUPLICATE", incident: "I3", passed: true },
  ),
  c("G-16", "the agent's crop comparison settles the fast path's doubt", g(proposal("DUPLICATE", "I1", ["step_3"]), [compareStep("step_3", "I1", "same", 0.88)]), {
    label: "DUPLICATE",
    incident: "I1",
    passed: true,
  }),
  c("G-17", "a more conservative proposal stands", g(proposal("NEW", null, ["step_2"]), [compareStep("step_2", "I1", "same", 0.9)]), {
    label: "NEW",
    passed: true,
    decide: "DUPLICATE",
  }),
  c(
    "G-18",
    "the rules are more conservative",
    g(
      proposal("DUPLICATE", "I1", ["step_2"]),
      [compareStep("step_2", "I1", "same", 0.9)],
      input({ candidates: [cand("I1", "open"), cand("I2", "open")], comparisons: [cmp("I1", "uncertain", 0.5, { stage: 1 }), cmp("I2", "same", 0.85)] }),
    ),
    { label: "HUMAN_REVIEW", passed: false, blocked: ["G4"], decide: "HUMAN_REVIEW" },
  ),
  c("G-19", "rules that still need information count as human review", g(proposal("NEW", null, ["step_2"]), [compareStep("step_2", "I1", "uncertain", 0.5)]), {
    label: "HUMAN_REVIEW",
    passed: false,
    blocked: ["G4"],
    decide: "NEEDS_INFO",
  }),
  c(
    "G-20",
    "same label, another incident in the chain",
    g(
      proposal("LATE_REPORT", "I1", ["step_2"]),
      [compareStep("step_2", "I1", "same", 0.9)],
      input({
        candidates: [
          cand("I0", "resolved", { created_at: at("-30d"), resolved_at: at("-20d") }),
          cand("I1", "resolved", { created_at: at("-10d"), recurrence_of: "I0" }),
        ],
        observed: at("-25d"),
        comparisons: [cmp("I0", "same", 0.9)],
      }),
    ),
    { label: "HUMAN_REVIEW", passed: false, blocked: ["G4"], decide: "LATE_REPORT" },
  ),
  c(
    "G-21",
    "the rules see a recurrence in a crop the agent did not cite",
    g(
      proposal("ALREADY_RESOLVED", "I1", ["step_2"]),
      [compareStep("step_2", "I1", "same", 0.9, { mode: "full", stage: 1, dmg: false, rep: true }), compareStep("step_3", "I1", "same", 0.9, { sig: "different" })],
      resolvedI1(at("+2d")),
    ),
    { label: "POSSIBLE_RECURRENCE", incident: "I1", passed: false, blocked: ["G4"], decide: "POSSIBLE_RECURRENCE" },
  ),
  c(
    "G-22",
    "an incident the agent only looked up does not become a candidate",
    g(proposal("DUPLICATE", "I1", ["step_2"]), [compareStep("step_2", "I1", "same", 0.9)], unsure(), [cand("I5", "open")]),
    { label: "DUPLICATE", incident: "I1", passed: true },
  ),
  c(
    "G-23",
    "facts from the search when the incident lookup has none",
    { ...g(proposal("DUPLICATE", "I3", ["step_1", "step_2"]), [searchStep("step_1", [cand("I3", "open")]), compareStep("step_2", "I3", "same", 0.9)], input()), incidents: {} },
    { label: "DUPLICATE", incident: "I3", passed: true },
  ),
  c(
    "G-24",
    "a recurrence needs same-asset evidence for its parent too",
    g(proposal("POSSIBLE_RECURRENCE", "I2", ["step_1"]), [searchStep("step_1", [cand("I2", "resolved")])], unsure(), [cand("I2", "resolved")]),
    { label: "HUMAN_REVIEW", passed: false, blocked: ["G1"] },
  ),
  c(
    "G-25",
    "a more cautious label on another incident than the rules' does not stand",
    g(
      proposal("POSSIBLE_RECURRENCE", "I1", ["step_2"]),
      [compareStep("step_2", "I1", "same", 0.9, { sig: "different" })],
      input({
        candidates: [cand("I1", "resolved"), cand("I2", "open", { recurrence_of: "I1", created_at: at("+15d") })],
        observed: at("+16d"),
        comparisons: [cmp("I2", "same", 0.9)],
      }),
    ),
    { label: "HUMAN_REVIEW", passed: false, blocked: ["G4"], decide: "DUPLICATE" },
  ),
];

const BURYING: Label[] = ["DUPLICATE", "LATE_REPORT", "ALREADY_RESOLVED"];
const CAUTION: Label[] = ["ALREADY_RESOLVED", "LATE_REPORT", "DUPLICATE", "NEW", "POSSIBLE_RECURRENCE", "HUMAN_REVIEW"];
const rank = (l: Label) => CAUTION.indexOf(l === "NEEDS_INFO" ? "HUMAN_REVIEW" : l);

function checkProperties(i: GuardInput, out: GuardResult) {
  const cited = i.proposal.evidence_refs.flatMap((ref) => i.steps.filter((s) => s.ref === ref && s.ok && s.tool === "compare_images"));
  const confident = cited.some((s) => {
    const d = s.data as { candidate_incident_id: string; asset_match: { verdict: string; confidence: number } };
    return d.candidate_incident_id === out.final_incident_id && d.asset_match.verdict === "same" && d.asset_match.confidence >= TEST_CONFIG.match_conf;
  });
  if (BURYING.includes(out.final_label) && out.final_label === i.proposal.label) expect(confident, "G-P1").toBe(true);
  if (out.final_label === "DUPLICATE" || out.final_label === "LATE_REPORT") {
    const inc = i.incidents[out.final_incident_id!];
    const afterFix = inc?.resolved_at && Date.parse(i.base.report.observed_at) > Date.parse(inc.resolved_at) + TEST_CONFIG.time_margin_h * 3_600_000;
    expect(afterFix && cited.some((s) => (s.data as { damage: { new_damage_present: boolean } }).damage.new_damage_present), "G-P2").toBeFalsy();
  }
  expect(rank(out.final_label), "G-P3").toBeGreaterThanOrEqual(Math.min(rank(out.decide_label), rank(i.proposal.label)));
  if (out.blocked_rules.includes("G4")) expect(rank(out.final_label), "G-P3").toBeGreaterThanOrEqual(Math.max(rank(out.decide_label), rank(i.proposal.label)));
  expect(out.final_label, "G-P4").not.toBe("NEEDS_INFO");
  if (out.blocked_rules.length > 0) expect(out.passed, "G-P5").toBe(false);
  if (out.blocked_rules.some((r) => r !== "G4")) expect(out.final_label, "G-P5").toBe("HUMAN_REVIEW");
}

describe("guard", () => {
  it.each(CASES.map((x) => [x.id, x.desc, x] as const))("%s %s", (_, __, { input: i, expected }) => {
    const out = guard(deepFreeze(i));
    expect(out.final_label).toBe(expected.label);
    expect(out.final_incident_id).toBe(expected.incident ?? null);
    expect(out.passed).toBe(expected.passed);
    expect(out.blocked_rules).toEqual(expected.blocked ?? []);
    if (expected.decide) expect(out.decide_label).toBe(expected.decide);
    checkProperties(i, out);
    expect(guard(i)).toEqual(out);
  });
});
