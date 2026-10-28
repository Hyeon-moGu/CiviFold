// Author: HyeonMo Gu
// Created: 2026-10-27

import { describe, expect, it } from "vitest";
import type { Candidate } from "./decide";
import { route, type RouteInput } from "./route";
import { channelOf, messageText } from "./intake";

const near = (id: string, distance_m: number): Candidate => ({
  incident_id: id,
  status: "open",
  created_at: "2026-10-24T09:00:00.000Z",
  resolved_at: null,
  recurrence_of: null,
  distance_m,
});

const words = (over: Partial<NonNullable<RouteInput["intake"]>> = {}) => ({ emergency: false, emergency_reason: null, out_of_scope: false, ...over });

const CASES: Array<{ id: string; input: Partial<RouteInput>; expect: { label: string; rule_id: string; urgent?: boolean; missing?: string[] } | null }> = [
  { id: "I-1 photo, no words → photo pipeline", input: { has_photo: true, intake: null }, expect: null },
  { id: "I-2 photo and ordinary words → photo pipeline", input: { has_photo: true, intake: words() }, expect: null },
  { id: "I-3 photo and an emergency → staff at once", input: { has_photo: true, intake: words({ emergency: true, emergency_reason: "Smoke from the pole." }) }, expect: { label: "HUMAN_REVIEW", rule_id: "R0e", urgent: true } },
  { id: "I-4 no photo, emergency → staff at once", input: { intake: words({ emergency: true }), candidates: [near("inc_a", 5)] }, expect: { label: "HUMAN_REVIEW", rule_id: "R0e", urgent: true } },
  { id: "I-5 emergency outranks out of scope", input: { intake: words({ emergency: true, out_of_scope: true }) }, expect: { label: "HUMAN_REVIEW", rule_id: "R0e", urgent: true } },
  { id: "I-6 no photo, people or behavior → staff", input: { intake: words({ out_of_scope: true }) }, expect: { label: "HUMAN_REVIEW", rule_id: "R0s" } },
  { id: "I-6b photo, but the words are about people → staff", input: { has_photo: true, intake: words({ out_of_scope: true }) }, expect: { label: "HUMAN_REVIEW", rule_id: "R0s" } },
  { id: "I-11 photo only, resident ticked danger → staff at once", input: { has_photo: true, danger: true }, expect: { label: "HUMAN_REVIEW", rule_id: "R0e", urgent: true } },
  { id: "I-7 no photo, nothing nearby → new", input: { intake: words(), candidates: [] }, expect: { label: "NEW", rule_id: "R1p" } },
  { id: "I-8 no photo, an incident nearby → ask for a photo", input: { intake: words(), candidates: [near("inc_a", 3)] }, expect: { label: "NEEDS_INFO", rule_id: "R0p", missing: ["photo"] } },
  { id: "I-9 no photo after asking once → staff (P1)", input: { intake: words(), candidates: [near("inc_a", 3)], already_asked: true }, expect: { label: "HUMAN_REVIEW", rule_id: "P1" } },
  { id: "I-10 no photo, no words → staff", input: { intake: null }, expect: { label: "HUMAN_REVIEW", rule_id: "R0n" } },
];

describe("route", () => {
  it.each(CASES)("$id", ({ input, expect: want }) => {
    const d = route({ has_photo: false, danger: false, intake: null, already_asked: false, candidates: [], ...input });
    if (want === null) return expect(d).toBeNull();
    expect(d).toMatchObject({ label: want.label, rule_id: want.rule_id, urgent: want.urgent ?? false, incident_id: null });
    expect(d!.missing_info).toEqual(want.missing ?? []);
  });

  it("names every nearby incident for staff without matching any", () => {
    const d = route({ has_photo: false, danger: false, intake: words(), already_asked: false, candidates: [near("inc_a", 3.4), near("inc_b", 28)] })!;
    expect(d.reasons[0]!.text).toContain("inc_a (3 m), inc_b (28 m)");
  });

  it("keeps the photo request among the reasons after asking", () => {
    const d = route({ has_photo: false, danger: false, intake: words(), already_asked: true, candidates: [near("inc_a", 3)] })!;
    expect(d.reasons.map((r) => r.rule_id)).toEqual(["R0p", "P1"]);
  });
});

describe("channelOf", () => {
  it.each([
    [{ photo: true, text: false, voice: false }, "photo"],
    [{ photo: true, text: true, voice: false }, "photo_text"],
    [{ photo: false, text: true, voice: false }, "text"],
    [{ photo: false, text: false, voice: true }, "voice"],
    [{ photo: false, text: true, voice: true }, "voice"],
    [{ photo: true, text: true, voice: true }, "voice_photo"],
  ] as const)("%o → %s", (input, channel) => expect(channelOf(input)).toBe(channel));
});

describe("messageText", () => {
  it("joins typed text and transcript, dropping blanks", () => {
    expect(messageText(" Leaking ", "It is by the bakery.")).toBe("Leaking\nIt is by the bakery.");
    expect(messageText("  ", null)).toBeNull();
  });
});
