// Author: HyeonMo Gu
// Created: 2026-10-27

import { describe, expect, it } from "vitest";
import type { Label, MissingItem } from "../tools/types";
import { at, cand, cmp, deepFreeze, failed, input } from "./__fixtures__/builders";
import { decide, type DecideInput, type Decision } from "./decide";

type Expected = {
  label: Label;
  incident_id?: string | null; // defaults to null
  rule_id: string;
  via?: string; // an earlier rule that must appear in reasons (e.g. R4c, R0)
  missing_info?: MissingItem[];
  confidence?: number;
};
type Case = { id: string; desc: string; input: DecideInput; expected: Expected };

const c = (id: string, desc: string, i: DecideInput, expected: Expected): Case => ({ id, desc, input: i, expected });

// Recurrence chain used by D-17 to D-19: I1 repaired at R, I2 reopened 15 days later.
const chain = () => [cand("I1", "resolved"), cand("I2", "open", { recurrence_of: "I1", created_at: at("+15d") })];
const repaired = () => [cand("I1", "resolved")];

const DECIDE_CASES: Case[] = [
  // R0 photo quality
  c("D-01", "blurry photo", input({ quality: "blurry" }), { label: "NEEDS_INFO", rule_id: "R0", missing_info: ["close_up"] }),
  c(
    "D-02",
    "quality beats matching",
    input({ quality: "object_not_visible", candidates: [cand("I1", "open")], comparisons: [cmp("I1", "same", 0.95)] }),
    { label: "NEEDS_INFO", rule_id: "R0", missing_info: ["wider_context"] },
  ),
  c("D-03", "already asked → escalate", input({ quality: "blurry", asked: true }), { label: "HUMAN_REVIEW", rule_id: "P1", via: "R0" }),

  // R1–R3 candidates and thresholds
  c("D-04", "no candidates", input(), { label: "NEW", rule_id: "R1" }),
  c("D-05", "different at boundary", input({ candidates: [cand("I1", "open")], comparisons: [cmp("I1", "different", 0.6)] }), {
    label: "NEW",
    rule_id: "R3",
    confidence: 0.6,
  }),
  c(
    "D-06",
    "different but not confident",
    input({ candidates: [cand("I1", "open")], comparisons: [cmp("I1", "different", 0.59, { missing: ["different_angle"] })] }),
    { label: "NEEDS_INFO", rule_id: "R5", missing_info: ["different_angle"] },
  ),
  c(
    "D-07",
    "every candidate differs",
    input({
      candidates: [cand("I1", "open"), cand("I2", "open")],
      comparisons: [cmp("I1", "different", 0.8), cmp("I2", "different", 0.8)],
    }),
    { label: "NEW", rule_id: "R3" },
  ),
  c("D-08", "MATCH at boundary", input({ candidates: [cand("I1", "open")], comparisons: [cmp("I1", "same", 0.75)] }), {
    label: "DUPLICATE",
    incident_id: "I1",
    rule_id: "R6a",
  }),
  c("D-09", "just below MATCH", input({ candidates: [cand("I1", "open")], comparisons: [cmp("I1", "same", 0.749)] }), {
    label: "NEEDS_INFO",
    rule_id: "R5",
    missing_info: ["wider_context"],
  }),
  c("D-10", "verdict beats confidence", input({ candidates: [cand("I1", "open")], comparisons: [cmp("I1", "uncertain", 0.95)] }), {
    label: "NEEDS_INFO",
    rule_id: "R5",
  }),
  c("D-11", "comparison call failed", input({ candidates: [cand("I1", "open")], comparisons: [failed("I1")] }), {
    label: "NEEDS_INFO",
    rule_id: "R5",
    missing_info: ["wider_context"],
  }),

  // R2 aggregation per incident
  c(
    "D-12",
    "crops replace full photo",
    input({ candidates: [cand("I1", "open")], comparisons: [cmp("I1", "uncertain", 0.5, { stage: 1 }), cmp("I1", "same", 0.85)] }),
    { label: "DUPLICATE", incident_id: "I1", rule_id: "R6a" },
  ),
  c(
    "D-13",
    "crops say different, full photo ignored",
    input({ candidates: [cand("I1", "open")], comparisons: [cmp("I1", "same", 0.9, { stage: 1 }), cmp("I1", "different", 0.7)] }),
    { label: "NEW", rule_id: "R3" },
  ),
  c(
    "D-14",
    "several photos of one incident: highest confidence",
    input({ candidates: [cand("I1", "open")], comparisons: [cmp("I1", "uncertain", 0.6), cmp("I1", "same", 0.8)] }),
    { label: "DUPLICATE", incident_id: "I1", rule_id: "R6a" },
  ),

  // R4 several matches and chain collapse
  c(
    "D-15",
    "two unrelated incidents match",
    input({ candidates: [cand("I1", "open"), cand("I2", "open")], comparisons: [cmp("I1", "same", 0.9), cmp("I2", "same", 0.8)] }),
    { label: "HUMAN_REVIEW", rule_id: "R4" },
  ),
  c(
    "D-16",
    "one MATCH, one UNCERTAIN",
    input({ candidates: [cand("I1", "open"), cand("I2", "open")], comparisons: [cmp("I1", "same", 0.9), cmp("I2", "uncertain", 0.5)] }),
    { label: "DUPLICATE", incident_id: "I1", rule_id: "R6a" },
  ),
  c(
    "D-17",
    "chain: recurrence is open",
    input({
      candidates: chain(),
      observed: at("+16d"),
      comparisons: [cmp("I1", "same", 0.85, { sig: "different" }), cmp("I2", "same", 0.9)],
    }),
    { label: "DUPLICATE", incident_id: "I2", rule_id: "R6a", via: "R4c" },
  ),
  c(
    "D-18",
    "chain: old photo arrives late",
    input({
      candidates: chain(),
      observed: at("-1d"),
      comparisons: [cmp("I1", "same", 0.9), cmp("I2", "same", 0.85, { sig: "different" })],
    }),
    { label: "LATE_REPORT", incident_id: "I1", rule_id: "R7a", via: "R4c" },
  ),
  c(
    "D-19",
    "chain: observation outside every interval → most recent",
    input({
      candidates: chain(),
      observed: at("-5d"),
      comparisons: [cmp("I1", "same", 0.85, { sig: "different" }), cmp("I2", "same", 0.9)],
    }),
    { label: "DUPLICATE", incident_id: "I2", rule_id: "R6a", via: "R4c" },
  ),

  // R5 uncertain
  c(
    "D-20",
    "UNCERTAIN + NO_MATCH",
    input({
      candidates: [cand("I1", "open"), cand("I2", "open")],
      comparisons: [cmp("I1", "uncertain", 0.5, { missing: ["wider_context"] }), cmp("I2", "different", 0.8)],
    }),
    { label: "NEEDS_INFO", rule_id: "R5", missing_info: ["wider_context"] },
  ),
  c(
    "D-21",
    "uncertain after asking",
    input({
      asked: true,
      candidates: [cand("I1", "open"), cand("I2", "open")],
      comparisons: [cmp("I1", "uncertain", 0.5, { missing: ["wider_context"] }), cmp("I2", "different", 0.8)],
    }),
    { label: "HUMAN_REVIEW", rule_id: "R5" },
  ),
  c(
    "D-22",
    "missing items: union without duplicates",
    input({
      candidates: [cand("I1", "open"), cand("I2", "open")],
      comparisons: [
        cmp("I1", "uncertain", 0.5, { missing: ["close_up"] }),
        cmp("I2", "uncertain", 0.5, { missing: ["wider_context", "close_up"] }),
      ],
    }),
    { label: "NEEDS_INFO", rule_id: "R5", missing_info: ["close_up", "wider_context"] },
  ),

  // R6 open incident
  c("D-23", "in_progress counts as open", input({ candidates: [cand("I1", "in_progress")], comparisons: [cmp("I1", "same", 0.9, { sig: "uncertain" })] }), {
    label: "DUPLICATE",
    incident_id: "I1",
    rule_id: "R6a",
    confidence: 0.72,
  }),
  c("D-24", "different damage on the same asset", input({ candidates: [cand("I1", "open")], comparisons: [cmp("I1", "same", 0.9, { sig: "different" })] }), {
    label: "HUMAN_REVIEW",
    incident_id: "I1",
    rule_id: "R6b",
  }),
  c("D-25", "repaired but not recorded", input({ candidates: [cand("I1", "open")], comparisons: [cmp("I1", "same", 0.9, { dmg: false, rep: true })] }), {
    label: "HUMAN_REVIEW",
    incident_id: "I1",
    rule_id: "R6c",
  }),
  c("D-26", "no visible damage", input({ candidates: [cand("I1", "open")], comparisons: [cmp("I1", "same", 0.9, { dmg: false })] }), {
    label: "NEEDS_INFO",
    rule_id: "R6d",
    missing_info: ["close_up"],
  }),
  c(
    "D-27",
    "D-26 after asking",
    input({ asked: true, candidates: [cand("I1", "open")], comparisons: [cmp("I1", "same", 0.9, { dmg: false })] }),
    { label: "HUMAN_REVIEW", rule_id: "P1", via: "R6d" },
  ),

  // R7 repaired incident (I1 repaired at R, same .90)
  c("D-28", "late report", input({ candidates: repaired(), observed: at("-2d"), comparisons: [cmp("I1", "same", 0.9)] }), {
    label: "LATE_REPORT",
    incident_id: "I1",
    rule_id: "R7a",
    confidence: 0.9,
  }),
  c(
    "D-29",
    "late report, signature uncertain",
    input({ candidates: repaired(), observed: at("-2d"), comparisons: [cmp("I1", "same", 0.9, { sig: "uncertain" })] }),
    { label: "LATE_REPORT", incident_id: "I1", rule_id: "R7a", confidence: 0.72 },
  ),
  c(
    "D-30",
    "before repair but different damage",
    input({ candidates: repaired(), observed: at("-2d"), comparisons: [cmp("I1", "same", 0.9, { sig: "different" })] }),
    { label: "HUMAN_REVIEW", incident_id: "I1", rule_id: "R7b" },
  ),
  c(
    "D-31",
    "photo of the repaired state",
    input({ candidates: repaired(), observed: at("+2d"), comparisons: [cmp("I1", "same", 0.9, { dmg: false, rep: true })] }),
    { label: "ALREADY_RESOLVED", incident_id: "I1", rule_id: "R7c" },
  ),
  c(
    "D-32",
    "recurrence with different damage",
    input({ candidates: repaired(), observed: at("+17d"), comparisons: [cmp("I1", "same", 0.9, { sig: "different" })] }),
    { label: "POSSIBLE_RECURRENCE", incident_id: "I1", rule_id: "R7d" },
  ),
  c("D-33", "time vs evidence conflict", input({ candidates: repaired(), observed: at("+2d"), comparisons: [cmp("I1", "same", 0.9)] }), {
    label: "NEEDS_INFO",
    rule_id: "R7e",
    missing_info: ["observed_time"],
  }),
  c(
    "D-34",
    "D-33 after asking",
    input({ asked: true, candidates: repaired(), observed: at("+2d"), comparisons: [cmp("I1", "same", 0.9)] }),
    { label: "HUMAN_REVIEW", rule_id: "P1", via: "R7e" },
  ),
  c(
    "D-35",
    "same damage plus repair signs",
    input({ candidates: repaired(), observed: at("+2d"), comparisons: [cmp("I1", "same", 0.9, { rep: true })] }),
    { label: "POSSIBLE_RECURRENCE", incident_id: "I1", rule_id: "R7f" },
  ),
  c(
    "D-36",
    "damage with uncertain signature",
    input({ candidates: repaired(), observed: at("+2d"), comparisons: [cmp("I1", "same", 0.9, { sig: "uncertain" })] }),
    { label: "POSSIBLE_RECURRENCE", incident_id: "I1", rule_id: "R7f" },
  ),
  c(
    "D-37",
    "neither damage nor repair visible",
    input({ candidates: repaired(), observed: at("+2d"), comparisons: [cmp("I1", "same", 0.9, { dmg: false })] }),
    { label: "NEEDS_INFO", rule_id: "R7g", missing_info: ["close_up"] },
  ),
  c("D-38", "exactly −6h", input({ candidates: repaired(), observed: at("-6h"), comparisons: [cmp("I1", "same", 0.9)] }), {
    label: "HUMAN_REVIEW",
    incident_id: "I1",
    rule_id: "R7h",
  }),
  c("D-39", "−6h −1m", input({ candidates: repaired(), observed: at("-6h-1m"), comparisons: [cmp("I1", "same", 0.9)] }), {
    label: "LATE_REPORT",
    incident_id: "I1",
    rule_id: "R7a",
  }),
  c(
    "D-40",
    "exactly +6h",
    input({ candidates: repaired(), observed: at("+6h"), comparisons: [cmp("I1", "same", 0.9, { sig: "different" })] }),
    { label: "HUMAN_REVIEW", incident_id: "I1", rule_id: "R7h" },
  ),
  c(
    "D-41",
    "closed behaves like resolved",
    input({ candidates: [cand("I1", "closed")], observed: at("+17d"), comparisons: [cmp("I1", "same", 0.9, { sig: "different" })] }),
    { label: "POSSIBLE_RECURRENCE", incident_id: "I1", rule_id: "R7d" },
  ),
  c(
    "D-42",
    "resolved without a repair time",
    input({ candidates: [cand("I1", "resolved", { resolved_at: null })], comparisons: [cmp("I1", "same", 0.9)] }),
    { label: "HUMAN_REVIEW", incident_id: "I1", rule_id: "R7h" },
  ),
  c(
    "D-43",
    "recurrence_of cycle in bad data does not loop",
    input({
      candidates: [cand("I1", "open", { recurrence_of: "I2" }), cand("I2", "open", { recurrence_of: "I1", created_at: at("-1d") })],
      comparisons: [cmp("I1", "same", 0.9), cmp("I2", "same", 0.9)],
    }),
    { label: "DUPLICATE", incident_id: "I2", rule_id: "R6a", via: "R4c" },
  ),
  c(
    "D-44",
    "chain whose root lies outside the candidates",
    input({
      candidates: [cand("I2", "resolved", { recurrence_of: "I0" }), cand("I3", "open", { recurrence_of: "I2", created_at: at("+15d") })],
      observed: at("+16d"),
      comparisons: [cmp("I2", "same", 0.85, { sig: "different" }), cmp("I3", "same", 0.9)],
    }),
    { label: "DUPLICATE", incident_id: "I3", rule_id: "R6a", via: "R4c" },
  ),

  // Distant photo: matched like any other, close-up asked only after a repair
  c("D-45", "too far, no candidates", input({ quality: "too_far" }), { label: "NEW", rule_id: "R1" }),
  c(
    "D-46",
    "too far, matches an open incident",
    input({ quality: "too_far", candidates: [cand("I1", "open")], comparisons: [cmp("I1", "same", 0.9, { sig: "uncertain" })] }),
    { label: "DUPLICATE", incident_id: "I1", rule_id: "R6a", confidence: 0.72 },
  ),
  c(
    "D-47",
    "too far, observed after the repair",
    input({ quality: "too_far", candidates: repaired(), observed: at("+2d"), comparisons: [cmp("I1", "same", 0.9, { sig: "different" })] }),
    { label: "NEEDS_INFO", rule_id: "R7t", missing_info: ["close_up"], confidence: 0.9 },
  ),
  c(
    "D-48",
    "too far, observed before the repair",
    input({ quality: "too_far", candidates: repaired(), observed: at("-2d"), comparisons: [cmp("I1", "same", 0.9, { sig: "uncertain" })] }),
    { label: "LATE_REPORT", incident_id: "I1", rule_id: "R7a" },
  ),
  c(
    "D-49",
    "too far after the repair, already asked",
    input({ quality: "too_far", asked: true, candidates: repaired(), observed: at("+2d"), comparisons: [cmp("I1", "same", 0.9)] }),
    { label: "HUMAN_REVIEW", rule_id: "P1", via: "R7t" },
  ),
  c(
    "D-50",
    "too far, different asset",
    input({ quality: "too_far", candidates: [cand("I1", "open")], comparisons: [cmp("I1", "different", 0.9)] }),
    { label: "NEW", rule_id: "R3" },
  ),
];

// Timeline scenarios with ideal model outputs: rules alone must produce the answer.
const SCENARIOS: Case[] = [
  c("S-1", "first report", input(), { label: "NEW", rule_id: "R1" }),
  c("S-2", "other angle", input({ candidates: [cand("I1", "open")], comparisons: [cmp("I1", "same", 0.9)] }), {
    label: "DUPLICATE",
    incident_id: "I1",
    rule_id: "R6a",
  }),
  c("S-3", "close-up", input({ candidates: [cand("I1", "open")], comparisons: [cmp("I1", "same", 0.8)] }), {
    label: "DUPLICATE",
    incident_id: "I1",
    rule_id: "R6a",
  }),
  c("S-4", "late report", input({ candidates: repaired(), observed: at("-1d"), comparisons: [cmp("I1", "same", 0.9)] }), {
    label: "LATE_REPORT",
    incident_id: "I1",
    rule_id: "R7a",
  }),
  c(
    "S-5",
    "repaired state",
    input({ candidates: repaired(), observed: at("+2d"), comparisons: [cmp("I1", "same", 0.9, { dmg: false, rep: true })] }),
    { label: "ALREADY_RESOLVED", incident_id: "I1", rule_id: "R7c" },
  ),
  c(
    "S-6",
    "recurrence",
    input({ candidates: repaired(), observed: at("+17d"), comparisons: [cmp("I1", "same", 0.9, { sig: "different" })] }),
    { label: "POSSIBLE_RECURRENCE", incident_id: "I1", rule_id: "R7d" },
  ),
  c(
    "S-7",
    "recurrence from another angle",
    input({
      candidates: [cand("I1", "resolved"), cand("I2", "open", { recurrence_of: "I1", created_at: at("+17d") })],
      observed: at("+18d"),
      comparisons: [cmp("I1", "same", 0.85, { sig: "different" }), cmp("I2", "same", 0.9)],
    }),
    { label: "DUPLICATE", incident_id: "I2", rule_id: "R6a", via: "R4c" },
  ),
  c("S-8", "look-alike asset", input({ candidates: [cand("I1", "open")], comparisons: [cmp("I1", "different", 0.8)] }), {
    label: "NEW",
    rule_id: "R3",
  }),
  c("S-9", "old photo after repair", input({ candidates: repaired(), observed: at("+2d"), comparisons: [cmp("I1", "same", 0.9)] }), {
    label: "NEEDS_INFO",
    rule_id: "R7e",
    missing_info: ["observed_time"],
  }),
];

const LINKED: Label[] = ["DUPLICATE", "LATE_REPORT", "POSSIBLE_RECURRENCE", "ALREADY_RESOLVED"];

// D-P1 … D-P6, checked on every case.
function assertProperties(out: Decision, i: DecideInput) {
  expect(out.rule_id).toBeTruthy(); // P1
  expect(out.reasons.length).toBeGreaterThan(0);
  expect(out.reasons.at(-1)!.rule_id).toBe(out.rule_id);
  if (LINKED.includes(out.label)) expect(out.incident_id).not.toBeNull(); // P2
  if (out.label === "NEW" || out.label === "NEEDS_INFO") expect(out.incident_id).toBeNull();
  expect(out.missing_info.length > 0).toBe(out.label === "NEEDS_INFO"); // P3
  expect(decide(i)).toEqual(out); // P4 (input is deep-frozen by the caller)
  if (i.report.already_asked) expect(out.label).not.toBe("NEEDS_INFO"); // P5
  // P6: the order of candidates and comparisons does not matter.
  const flipped = decide({ ...i, candidates: [...i.candidates].reverse(), comparisons: [...i.comparisons].reverse() });
  expect({ ...flipped, reasons: [], missing_info: [...flipped.missing_info].sort() }).toEqual({
    ...out,
    reasons: [],
    missing_info: [...out.missing_info].sort(),
  });
}

function check({ input: i, expected }: Case) {
  const out = decide(deepFreeze(i));
  expect({ label: out.label, incident_id: out.incident_id, rule_id: out.rule_id }).toEqual({
    label: expected.label,
    incident_id: expected.incident_id ?? null,
    rule_id: expected.rule_id,
  });
  if (expected.via) expect(out.reasons.map((r) => r.rule_id)).toContain(expected.via);
  if (expected.missing_info) expect(out.missing_info).toEqual(expected.missing_info);
  if (expected.confidence !== undefined) expect(out.confidence).toBe(expected.confidence);
  assertProperties(out, i);
}

describe("decide", () => {
  it.each(DECIDE_CASES)("$id $desc", check);
});

describe("scenarios", () => {
  it.each(SCENARIOS)("$id $desc", check);
});
