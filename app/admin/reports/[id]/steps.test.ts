// Author: HyeonMo Gu
// Created: 2026-10-28

import { describe, expect, it } from "vitest";
import { verdictOf, type StepView } from "./steps";

const compare = (n: number, incident: string, verdict: string, confidence = 0.95): StepView => ({
  step: n,
  ref: `s${n}`,
  tool: "compare_images",
  ok: true,
  error: null,
  args: {},
  data: { asset_match: { verdict, confidence }, candidate_incident_id: incident, mode: "crops" },
});
const propose: StepView = { step: 9, ref: "s9", tool: "propose_decision", ok: true, error: null, args: { label: "DUPLICATE", incident_id: "inc_a" }, data: {} };
const before = { label: "DUPLICATE" as const, incident_id: "inc_a" };

const passed = { passed: true, blocked_rules: [] };

describe("verdictOf", () => {
  it("confirms only a finished, passed run with a comparison backing the suggestion and none against it", () => {
    const v = verdictOf({ status: "proposed", guard: passed, steps: [compare(1, "inc_a", "same"), compare(2, "inc_b", "different"), propose], before, after: before });
    expect(v).toMatchObject({ kind: "confirmed", checks: 2, against: [] });
    expect(v.agree).toHaveLength(2);
    // Ruling out a look-alike alone does not back the suggested incident.
    expect(verdictOf({ status: "proposed", guard: passed, steps: [compare(1, "inc_b", "different"), propose], before, after: before }).kind).toBe("unchanged");
  });

  it("says a blocked proposal did not back the suggestion, even with no checks", () => {
    const v = verdictOf({ status: "blocked", guard: { passed: false, blocked_rules: ["G3"] }, steps: [propose], before, after: before });
    expect(v).toMatchObject({ kind: "blocked", title: "Verification proposal blocked", checks: 0 });
  });

  it("shows evidence against whether or not the answer changed", () => {
    const kept = verdictOf({ status: "proposed", guard: passed, steps: [compare(1, "inc_a", "uncertain"), propose], before, after: before });
    expect(kept).toMatchObject({ kind: "against", title: "Suggestion kept, with evidence against it" });
    const changed = verdictOf({
      status: "proposed",
      guard: passed,
      steps: [compare(1, "inc_a", "uncertain"), compare(2, "inc_b", "same"), propose],
      before,
      after: { label: "HUMAN_REVIEW", incident_id: null, reason: "Two incidents match." },
    });
    expect(changed).toMatchObject({ kind: "against", detail: "Two incidents match." });
    expect(changed.against).toHaveLength(2);
  });

  it("does not call an unfinished or unexplained change a confirmation or evidence", () => {
    expect(verdictOf({ status: "failed", guard: null, steps: [compare(1, "inc_a", "same")], before, after: before }).kind).toBe("unsettled");
    expect(verdictOf({ status: "proposed", guard: passed, steps: [compare(1, "inc_a", "same"), propose], before, after: { label: "HUMAN_REVIEW", incident_id: null } }).kind).toBe("unsettled");
  });
});
