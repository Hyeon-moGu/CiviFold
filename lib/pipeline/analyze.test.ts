// Author: HyeonMo Gu
// Created: 2026-10-27

import type { SegmentationBoxRecord } from "@meta-sam/parser";
import sharp from "sharp";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { offsetM } from "../geo";
import { segment } from "../meta/sam";
import { sparkJson } from "../meta/spark";
import { memoryData, type IncidentRow } from "../tools/data";
import { memoryImages, type ImageRow } from "../tools/images";
import type { CompareResult, ToolContext } from "../tools/types";
import { analyze, photoRoles, withAnswerPhoto, type ReportInput } from "./analyze";
import type { Decision } from "./decide";
import type { TriageResult } from "./triage";

vi.mock("../meta/sam", () => ({ segment: vi.fn() }));
vi.mock("../meta/spark", () => ({ sparkJson: vi.fn() }));

const CALL = { model: "m", key: "k", cached: false, usd: 0, ms: 0 };
const HERE = { lat: 37.5665, lng: 126.978 };
const NOW = "2026-11-01T12:00:00.000Z";

const TRIAGE: TriageResult = {
  out_of_scope: false,
  category: "fire_hydrant",
  sam_prompt: "fire hydrant",
  damage_present: true,
  damage_description: "cap missing",
  repair_signs: false,
  context_landmarks: ["BAKERY sign"],
  image_quality: "ok",
  severity: "medium",
};

const SAME: CompareResult = {
  asset_match: { verdict: "same", confidence: 0.9, evidence: ["BAKERY sign", "green bike rack"] },
  damage: { new_damage_present: true, candidate_damage_present: true, same_damage_signature: "same", repair_signs_in_new: false, evidence: [] },
  view_change: "different_angle",
  missing_info: [],
  summary: "",
};

let png: Buffer;
beforeEach(async () => {
  png ??= await sharp({ create: { width: 400, height: 300, channels: 3, background: "#777777" } }).png().toBuffer();
  vi.mocked(segment).mockReset();
  vi.mocked(sparkJson).mockReset();
  const box: SegmentationBoxRecord = { kind: "box", order: 0, objectId: "a", left: 150, top: 100, right: 250, bottom: 200, confidence: 0.9 };
  vi.mocked(segment).mockResolvedValue({ boxes: [box], masks: [], diagnostics: [], call: CALL } as unknown as Awaited<ReturnType<typeof segment>>);
});

function sparkReturns(triage: TriageResult, compare: CompareResult | Error = SAME) {
  vi.mocked(sparkJson).mockImplementation(async ({ name }) => {
    if (name === "triage") return { data: triage, call: CALL };
    if (compare instanceof Error) throw compare;
    return { data: compare, call: CALL };
  });
}

const sparkNames = () => vi.mocked(sparkJson).mock.calls.map((c) => c[0].name);

function original(id: string, report_id: string): { row: ImageRow; bytes: Buffer } {
  return { row: { id, report_id, kind: "original", source_image_id: null, width: 400, height: 300, mime: "image/png", is_synthetic: true }, bytes: png };
}

function incident(id: string, northM: number, extra: Partial<IncidentRow> = {}): IncidentRow {
  return {
    id,
    category: "fire_hydrant",
    status: "open",
    ...offsetM(HERE, northM, 0),
    title: id,
    created_at: "2026-10-30T12:00:00.000Z",
    resolved_at: null,
    recurrence_of: null,
    representative_report_id: null,
    ...extra,
  };
}

function setup(incidents: IncidentRow[] = [], extra: Array<{ row: ImageRow; bytes: Buffer }> = []): ToolContext {
  return {
    reportId: "r_new",
    runId: null,
    mode: "cached",
    budget: { usdLeft: 1, deadline: 0 },
    data: memoryData({
      asOf: NOW,
      incidents,
      photos: incidents.map((i) => ({ image_id: `img_${i.id}`, report_id: `r_${i.id}`, incident_id: i.id, observed_at: i.created_at })),
    }),
    images: memoryImages({
      images: [original("img_new", "r_new"), ...extra, ...incidents.map((i) => original(`img_${i.id}`, `r_${i.id}`))],
      incidentByReport: Object.fromEntries(incidents.map((i) => [`r_${i.id}`, i.id])),
    }),
  };
}

const REPORT: ReportInput = {
  report_id: "r_new",
  image_id: "img_new",
  ...HERE,
  observed_at: NOW,
  description: null,
  category_hint: null,
  already_asked: false,
};

describe("analyze", () => {
  it("stops after triage when the photo shows nothing to compare", async () => {
    sparkReturns({ ...TRIAGE, image_quality: "blurry" });
    const a = await analyze(REPORT, setup([incident("I1", 5)]));
    expect(a.decision).toMatchObject({ label: "NEEDS_INFO", rule_id: "R0" });
    expect(a.candidates).toEqual([]);
    expect(sparkNames()).toEqual(["triage"]);
    expect(segment).not.toHaveBeenCalled();
  });

  it("routes complaints about people to staff without search or image matching", async () => {
    sparkReturns({ ...TRIAGE, out_of_scope: true, category: "other" });
    const a = await analyze(REPORT, setup([incident("I1", 5)]));
    expect(a.decision).toMatchObject({ label: "HUMAN_REVIEW", rule_id: "R0s" });
    expect(a.candidates).toEqual([]);
    expect(sparkNames()).toEqual(["triage"]);
    expect(segment).not.toHaveBeenCalled();
  });

  it("calls NEW without SAM or comparisons when nothing is nearby", async () => {
    sparkReturns(TRIAGE);
    const a = await analyze(REPORT, setup([incident("far", 100)]));
    expect(a.decision).toMatchObject({ label: "NEW", rule_id: "R1" });
    expect(sparkNames()).toEqual(["triage"]);
    expect(segment).not.toHaveBeenCalled();
  });

  it("compares each candidate with full photos and crops, then decides", async () => {
    sparkReturns(TRIAGE);
    const a = await analyze(REPORT, setup([incident("I1", 5)]));
    expect(a.decision).toMatchObject({ label: "DUPLICATE", incident_id: "I1", rule_id: "R6a" });
    expect(a.comparisons.map((c) => [c.incident_id, c.stage])).toEqual([["I1", 1], ["I1", 2]]);
    expect(a.segmentation?.found).toBe(true);
    expect(sparkNames()).toEqual(["triage", "compare", "compare"]);
    expect(a.prompt_hash.triage).toMatch(/^[0-9a-f]{12}$/);
  });

  it("searches only the triaged category within its radius", async () => {
    sparkReturns(TRIAGE);
    const a = await analyze(REPORT, setup([incident("I1", 5), incident("light", 3, { category: "streetlight" }), incident("I_far", 45)]));
    expect(a.candidates.map((c) => c.incident_id)).toEqual(["I1"]);
  });

  it("searches the category the resident picked when the photo suggests another", async () => {
    sparkReturns({ ...TRIAGE, category: "graffiti", sam_prompt: "graffiti" });
    const a = await analyze({ ...REPORT, category_hint: "fire_hydrant" }, setup([incident("I1", 5)]));
    expect(a.candidates.map((c) => c.incident_id)).toEqual(["I1"]);
    const unhinted = await analyze(REPORT, setup([incident("I1", 5)]));
    expect(unhinted.candidates).toEqual([]);
  });

  it("keeps failed comparisons as missing results and records the error", async () => {
    sparkReturns(TRIAGE, new Error("Spark down"));
    const a = await analyze(REPORT, setup([incident("I1", 5)]));
    expect(a.comparisons.every((c) => c.result === null)).toBe(true);
    expect(a.errors).toHaveLength(2);
    expect(a.decision).toMatchObject({ label: "NEEDS_INFO", rule_id: "R5" });
  });

  it("compares an answer photo alongside the first one", async () => {
    sparkReturns(TRIAGE);
    const ctx = setup([incident("I1", 5)], [original("img_close", "r_new")]);
    const a = await analyze({ ...REPORT, answer_image_ids: ["img_close"], already_asked: true }, ctx);
    expect(a.comparisons.map((c) => [c.new_image_id, c.stage]).sort()).toEqual([["img_close", 1], ["img_close", 2], ["img_new", 1], ["img_new", 2]]);
    expect(sparkNames()).toEqual(["triage", "compare", "compare", "compare", "compare"]);
    expect(a.segmentation?.found).toBe(true);
  });

  it("adds an answer photo, or replaces a first photo that showed nothing usable", () => {
    const decision = (rule_id: string): Decision => ({ label: "NEEDS_INFO", incident_id: null, rule_id, reasons: [], confidence: 0, missing_info: ["close_up"] });
    expect(withAnswerPhoto(REPORT, decision("R6d"), "img_close")).toMatchObject({ image_id: "img_new", answer_image_ids: ["img_close"], already_asked: true });
    expect(withAnswerPhoto(REPORT, decision("R0"), "img_close")).toMatchObject({ image_id: "img_close", answer_image_ids: [], already_asked: true, asked_by: "R0" });
  });

  it("picks the same photos from a report's stored list as the evaluation does", () => {
    expect(photoRoles(["img_new", "img_close"], "R6d")).toEqual({ image_id: "img_new", answer_image_ids: ["img_close"] });
    expect(photoRoles(["img_blurry", "img_sharp"], "R0")).toEqual({ image_id: "img_sharp", answer_image_ids: [] });
    expect(photoRoles(["img_only"], "R0")).toEqual({ image_id: "img_only", answer_image_ids: [] });
  });

  it("does not ask for a close-up again once the one R7t asked for arrived", async () => {
    sparkReturns({ ...TRIAGE, image_quality: "too_far" }, { ...SAME, damage: { ...SAME.damage, same_damage_signature: "different" } });
    const fixed = incident("I1", 5, { status: "resolved", resolved_at: "2026-10-31T00:00:00.000Z" });
    const first = await analyze(REPORT, setup([fixed]));
    expect(first.decision).toMatchObject({ label: "NEEDS_INFO", rule_id: "R7t" });
    const ctx = setup([fixed], [original("img_close", "r_new")]);
    const again = await analyze(withAnswerPhoto(REPORT, first.decision, "img_close"), ctx);
    expect(again.decision).toMatchObject({ label: "POSSIBLE_RECURRENCE", rule_id: "R7d" });
  });

  it("reports a crop request that fell back to full photos as stage 1", async () => {
    sparkReturns(TRIAGE);
    vi.mocked(segment).mockResolvedValue({ boxes: [], masks: [], diagnostics: [], call: CALL } as unknown as Awaited<ReturnType<typeof segment>>);
    const a = await analyze(REPORT, setup([incident("I1", 5)]));
    expect(a.comparisons.map((c) => c.stage)).toEqual([1, 1]);
  });
});
