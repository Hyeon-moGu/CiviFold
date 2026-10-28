// Author: HyeonMo Gu
// Created: 2026-10-27

import type { Label } from "../tools/types";

export type Outcome = "correct" | "deferred" | "safe_error" | "critical";

export type Prediction = { label: Label; incident: string | null };

const LINKED: ReadonlySet<Label> = new Set(["DUPLICATE", "LATE_REPORT", "ALREADY_RESOLVED", "POSSIBLE_RECURRENCE"]);
// Labels that close the matter for staff in one click: on the wrong report they bury a problem.
const BURYING: ReadonlySet<Label> = new Set(["DUPLICATE", "LATE_REPORT", "ALREADY_RESOLVED"]);
const NEEDS_ATTENTION: ReadonlySet<Label> = new Set(["NEW", "POSSIBLE_RECURRENCE"]);

export function classify(expected: Prediction, predicted: Prediction): Outcome {
  const sameTarget = !LINKED.has(predicted.label) || predicted.incident === expected.incident;
  if (predicted.label === expected.label && sameTarget) return "correct";
  if (predicted.label === "HUMAN_REVIEW" || predicted.label === "NEEDS_INFO") return "deferred";
  if (BURYING.has(predicted.label) && (NEEDS_ATTENTION.has(expected.label) || predicted.incident !== expected.incident)) return "critical";
  return "safe_error";
}

export type ScoredCase = {
  expected: Prediction;
  predicted: Prediction;
  outcome: Outcome;
  asked: string | null; // the item the simulated resident was asked for
  cost_usd: number;
  latency_ms: number;
};

export function summarize(cases: ScoredCase[]) {
  const n = cases.length;
  const count = (f: (c: ScoredCase) => boolean) => cases.filter(f).length;
  const ratio = (a: number, b: number) => (b === 0 ? null : a / b);
  const isDup = (l: Label) => l === "DUPLICATE" || l === "LATE_REPORT";
  const correctDup = count((c) => c.outcome === "correct" && isDup(c.expected.label));

  const confusion: Record<string, Record<string, number>> = {};
  for (const c of cases) {
    const row = (confusion[c.expected.label] ??= {});
    row[c.predicted.label] = (row[c.predicted.label] ?? 0) + 1;
  }
  return {
    cases: n,
    outcomes: {
      correct: count((c) => c.outcome === "correct"),
      deferred: count((c) => c.outcome === "deferred"),
      safe_error: count((c) => c.outcome === "safe_error"),
      critical: count((c) => c.outcome === "critical"),
    },
    critical_miss_rate: ratio(count((c) => c.outcome === "critical" && NEEDS_ATTENTION.has(c.expected.label)), count((c) => NEEDS_ATTENTION.has(c.expected.label))),
    review_reduction: ratio(correctDup, n),
    dup_precision: ratio(correctDup, count((c) => isDup(c.predicted.label))),
    dup_recall: ratio(correctDup, count((c) => isDup(c.expected.label))),
    deferral_rate: ratio(count((c) => c.outcome === "deferred"), n),
    // The simulation answers every question. A resident who never answers leaves the report to staff,
    // so this is the staff share when nobody answers; the real rate lies between the two.
    staff_review_if_no_answer: ratio(count((c) => c.outcome === "deferred" || c.asked !== null), n),
    question_rate: ratio(count((c) => c.asked !== null), n),
    usd_per_report: ratio(cases.reduce((s, c) => s + c.cost_usd, 0), n),
    seconds_per_report: ratio(cases.reduce((s, c) => s + c.latency_ms, 0) / 1000, n),
    confusion,
    stages: stages(cases),
  };
}

// Outcomes before and after the simulated resident answers. A report that asked waits on the resident and goes to
// staff if nobody answers, so it is deferred in both cases: the first decision is also the no-answer outcome.
export function stages(cases: ScoredCase[]) {
  const tally = (outcomeOf: (c: ScoredCase) => Outcome) => {
    const of = cases.map((c) => ({ c, o: outcomeOf(c) }));
    const n = (f: (x: { c: ScoredCase; o: Outcome }) => boolean) => of.filter(f).length;
    const attention = n((x) => NEEDS_ATTENTION.has(x.c.expected.label));
    return {
      correct: n((x) => x.o === "correct"),
      deferred: n((x) => x.o === "deferred"),
      safe_error: n((x) => x.o === "safe_error"),
      critical: n((x) => x.o === "critical"),
      critical_miss_rate: attention === 0 ? null : n((x) => x.o === "critical" && NEEDS_ATTENTION.has(x.c.expected.label)) / attention,
    };
  };
  const asked = cases.filter((c) => c.asked !== null);
  const after = (o: Outcome) => asked.filter((c) => c.outcome === o).length;
  return {
    first_or_no_answer: tally((c) => (c.asked !== null ? "deferred" : c.outcome)),
    after_answer: tally((c) => c.outcome),
    asked: asked.length,
    answer_effect: { correct: after("correct"), still_deferred: after("deferred"), safe_error: after("safe_error"), critical: after("critical") },
  };
}

export type Summary = ReturnType<typeof summarize>;
