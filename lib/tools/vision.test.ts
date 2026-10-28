// Author: HyeonMo Gu
// Created: 2026-10-27

import type { SegmentationBoxRecord } from "@meta-sam/parser";
import sharp from "sharp";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { segment } from "../meta/sam";
import { sparkJson } from "../meta/spark";
import { normalizeTriage, triage, type TriageResult } from "../pipeline/triage";
import { compareImages, requireDistinctiveEvidence } from "./compare-images";
import { memoryData } from "./data";
import { memoryImages, type ImageRow } from "./images";
import { chooseInstance, contextCropRect, segmentObject } from "./segment-object";
import type { CompareResult, ToolContext } from "./types";

vi.mock("../meta/sam", () => ({ segment: vi.fn() }));
vi.mock("../meta/spark", () => ({ sparkJson: vi.fn() }));

const CALL = { model: "m", key: "k", cached: false, usd: 0, ms: 0 };
const W = 400;
const H = 300;

let png: Buffer;
beforeEach(async () => {
  vi.mocked(segment).mockReset();
  vi.mocked(sparkJson).mockReset();
  png ??= await sharp({ create: { width: W, height: H, channels: 3, background: "#888888" } }).png().toBuffer();
});

function box(objectId: string, left: number, top: number, right: number, bottom: number, confidence?: number): SegmentationBoxRecord {
  return { kind: "box", order: 0, objectId, left, top, right, bottom, confidence };
}

function samReturns(...boxes: SegmentationBoxRecord[]) {
  vi.mocked(segment).mockResolvedValue({ boxes, masks: [], diagnostics: [], call: CALL } as unknown as Awaited<ReturnType<typeof segment>>);
}

function original(id: string, report_id: string): { row: ImageRow; bytes: Buffer } {
  return { row: { id, report_id, kind: "original", source_image_id: null, width: W, height: H, mime: "image/png", is_synthetic: true }, bytes: png };
}

function setup() {
  const images = memoryImages({
    images: [original("img_new", "r_new"), original("img_cand", "r_old"), original("img_cand2", "r_old"), original("img_other", "r_loose")],
    incidentByReport: { r_old: "inc_1" },
    triageByReport: { r_new: { category: "fire_hydrant", sam_prompt: "fire hydrant" }, r_old: { category: "fire_hydrant", sam_prompt: "hydrant" } },
  });
  const ctx: ToolContext = {
    reportId: "r_new",
    runId: null,
    mode: "cached",
    budget: { usdLeft: 1, deadline: 0 },
    data: memoryData({ asOf: "2026-11-01T00:00:00.000Z", incidents: [] }),
    images,
  };
  return { images, ctx };
}

function compareResult(verdict: "same" | "different" | "uncertain", confidence: number, evidence: string[]): CompareResult {
  return {
    asset_match: { verdict, confidence, evidence },
    damage: { new_damage_present: true, candidate_damage_present: true, same_damage_signature: "same", repair_signs_in_new: false, evidence: [] },
    view_change: "different_angle",
    missing_info: [],
    summary: "",
  };
}

/** Every text the last Spark call received, system prompt included. */
const sentTexts = (): string[] =>
  vi
    .mocked(sparkJson)
    .mock.calls[0]![0].messages.flatMap((m): unknown[] => (Array.isArray(m.content) ? m.content : [{ text: m.content }]))
    .flatMap((p) => {
      const text = (p as { text?: unknown }).text;
      return typeof text === "string" ? [text] : [];
    });

describe("segment_object", () => {
  it("rejects lists and empty phrases before calling SAM", async () => {
    const { ctx } = setup();
    for (const phrase of ["hydrant and pole", "hydrant, pole", "sign or pole", " "]) {
      await expect(segmentObject.run({ image_id: "img_new", noun_phrase: phrase }, ctx)).rejects.toThrow();
    }
    expect(segment).not.toHaveBeenCalled();
  });

  it("prefers a centered instance over a stronger one in the corner", () => {
    const corner = box("a", 0, 0, 40, 40, 0.95);
    const center = box("b", 180, 130, 220, 170, 0.7);
    expect(chooseInstance([corner, center], W, H)?.objectId).toBe("b");
    expect(chooseInstance([], W, H)).toBeNull();
  });

  it("saves an object crop with 10% margin and a 3x context crop", async () => {
    const { ctx, images } = setup();
    samReturns(box("a", 150, 100, 250, 200, 0.9), box("b", 0, 0, 20, 20, 0.5));
    const out = await segmentObject.run({ image_id: "img_new", noun_phrase: "Fire Hydrant" }, ctx);

    expect(segment).toHaveBeenCalledWith(expect.stringMatching(/^data:image\/png;base64,/), "fire hydrant", { mode: "cached" });
    expect(out).toMatchObject({ found: true, instances: 2, chosen: { box: { x1: 150, y1: 100, x2: 250, y2: 200, w: W, h: H }, score: 0.9 } });
    const obj = await images.get(out.chosen!.object_crop_id);
    const context = await images.get(out.chosen!.context_crop_id);
    expect(obj).toMatchObject({ kind: "object_crop", source_image_id: "img_new", report_id: "r_new", width: 120, height: 120, mime: "image/webp" });
    expect(context).toMatchObject({ kind: "context_crop", width: 300, height: 300 });
    expect(await sharp(await images.bytes(obj!.id)).metadata()).toMatchObject({ width: 120, height: 120 });
    expect(images.segmentations).toHaveLength(1);
  });

  it("keeps the context crop at least half the frame and slides it inside at the edges", () => {
    expect(contextCropRect({ x1: 195, y1: 145, x2: 205, y2: 155, w: W, h: H })).toEqual({ left: 100, top: 75, width: 200, height: 150 });
    expect(contextCropRect({ x1: 0, y1: 0, x2: 20, y2: 20, w: W, h: H })).toEqual({ left: 0, top: 0, width: 200, height: 150 });
    expect(contextCropRect({ x1: 0, y1: 0, x2: 300, y2: 250, w: W, h: H })).toEqual({ left: 0, top: 0, width: W, height: H });
  });

  it("reuses crop ids when the same box is segmented again", async () => {
    const { ctx } = setup();
    samReturns(box("a", 150, 100, 250, 200, 0.9));
    const first = await segmentObject.run({ image_id: "img_new", noun_phrase: "fire hydrant" }, ctx);
    const second = await segmentObject.run({ image_id: "img_new", noun_phrase: "fire hydrant" }, ctx);
    expect(second.chosen).toEqual(first.chosen);
  });

  it("records a miss when SAM finds nothing", async () => {
    const { ctx, images } = setup();
    samReturns();
    expect(await segmentObject.run({ image_id: "img_new", noun_phrase: "bench" }, ctx)).toEqual({ found: false, instances: 0, chosen: null });
    expect(images.segmentations[0]).toMatchObject({ found: false, object_crop_id: null });
  });
});

describe("compare_images", () => {
  it("compares full photos and resolves the incident on the server", async () => {
    const { ctx } = setup();
    vi.mocked(sparkJson).mockResolvedValue({ data: compareResult("different", 0.9, ["LAUNDRY sign vs BAKERY sign"]), call: CALL });
    const out = await compareImages.run({ new_image_id: "img_new", candidate_image_id: "img_cand", mode: "full" }, ctx);

    expect(out).toMatchObject({ candidate_incident_id: "inc_1", mode: "full", asset_match: { verdict: "different" } });
    const texts = sentTexts();
    expect(texts.filter((t) => t.includes("IMAGE"))).toEqual(["NEW report:\nIMAGE N1 — full photo", "CANDIDATE incident photo:\nIMAGE C1 — full photo"]);
    expect(texts).toContain("Asset category reported: fire_hydrant");
    expect(texts.join("\n")).not.toMatch(/\d{4}-\d{2}-\d{2}/);
  });

  it("segments each side with its own report's phrase and sends four crops", async () => {
    const { ctx } = setup();
    samReturns(box("a", 150, 100, 250, 200, 0.9));
    vi.mocked(sparkJson).mockResolvedValue({ data: compareResult("same", 0.9, ["BAKERY sign", "green bike rack"]), call: CALL });
    const out = await compareImages.run({ new_image_id: "img_new", candidate_image_id: "img_cand", mode: "crops" }, ctx);

    expect(out.mode).toBe("crops");
    expect(vi.mocked(segment).mock.calls.map((c) => c[1]).sort()).toEqual(["fire hydrant", "hydrant"]);
    expect(sentTexts().filter((t) => t.includes("IMAGE"))).toHaveLength(4);
  });

  it("falls back to full photos when SAM finds nothing", async () => {
    const { ctx } = setup();
    samReturns();
    vi.mocked(sparkJson).mockResolvedValue({ data: compareResult("uncertain", 0.4, []), call: CALL });
    const out = await compareImages.run({ new_image_id: "img_new", candidate_image_id: "img_cand", mode: "crops" }, ctx);
    expect(out.mode).toBe("full");
  });

  it("refuses a candidate photo that belongs to no incident", async () => {
    const { ctx } = setup();
    await expect(compareImages.run({ new_image_id: "img_new", candidate_image_id: "img_other", mode: "full" }, ctx)).rejects.toThrow(
      "does not belong to an incident",
    );
    expect(sparkJson).not.toHaveBeenCalled();
  });

  it("refuses a new side that is not this report's photo, and the same photo on both sides", async () => {
    const { ctx, images } = setup();
    await expect(compareImages.run({ new_image_id: "img_cand", candidate_image_id: "img_cand2", mode: "full" }, ctx)).rejects.toThrow("not a photo of the report");
    await expect(compareImages.run({ new_image_id: "img_cand", candidate_image_id: "img_new", mode: "full" }, ctx)).rejects.toThrow("not a photo of the report");
    await images.put({ ...original("img_new_crop", "r_new").row, kind: "object_crop", source_image_id: "img_new" }, Buffer.alloc(0));
    await images.put({ ...original("img_new_copy", "r_old").row, source_image_id: "img_new" }, Buffer.alloc(0));
    await expect(compareImages.run({ new_image_id: "img_new_crop", candidate_image_id: "img_new_copy", mode: "full" }, ctx)).rejects.toThrow("same photo");
    expect(sparkJson).not.toHaveBeenCalled();
  });

  it("downgrades 'same' with fewer than two distinctive features and clamps confidence", () => {
    const weak = requireDistinctiveEvidence(compareResult("same", 0.88, ["yellow wall"]));
    expect(weak.asset_match).toMatchObject({ verdict: "uncertain", confidence: 0.5 });
    expect(weak.missing_info).toEqual(["wider_context"]);
    expect(requireDistinctiveEvidence(compareResult("same", 0.9, ["BAKERY sign", "bike rack"])).asset_match.verdict).toBe("same");
    expect(requireDistinctiveEvidence(compareResult("different", 1.3, [])).asset_match.confidence).toBe(1);
  });
});

describe("triage", () => {
  const base: TriageResult = {
    out_of_scope: false,
    category: "fire_hydrant",
    sam_prompt: "Fire Hydrant",
    damage_present: true,
    damage_description: "cap missing",
    repair_signs: false,
    context_landmarks: ["a", "b", "c", "d", "e"],
    image_quality: "ok",
    severity: "medium",
  };

  it("keeps an accepted SAM phrase and caps landmarks at 4", () => {
    expect(normalizeTriage(base)).toMatchObject({ sam_prompt: "fire hydrant", context_landmarks: ["a", "b", "c", "d"] });
  });

  it("replaces phrases outside the category's list with the default", () => {
    expect(normalizeTriage({ ...base, sam_prompt: "broken hydrant" }).sam_prompt).toBe("fire hydrant");
    expect(normalizeTriage({ ...base, category: "other", sam_prompt: "mailbox" }).sam_prompt).toBe("mailbox");
    expect(normalizeTriage({ ...base, category: "trash", sam_prompt: "Garbage Bags" }).sam_prompt).toBe("garbage bags");
    expect(normalizeTriage({ ...base, category: "road_damage", sam_prompt: "road hole" }).sam_prompt).toBe("pothole");
    expect(normalizeTriage({ ...base, category: "other", sam_prompt: "mailbox and pole" }).sam_prompt).toBe("object");
    expect(normalizeTriage({ ...base, category: "other", sam_prompt: "big blue public mailbox" }).sam_prompt).toBe("object");
  });

  it("sends the photo with the resident's note and returns the prompt hash", async () => {
    const { ctx } = setup();
    vi.mocked(sparkJson).mockResolvedValue({ data: base, call: CALL });
    const out = await triage("img_new", { description: "water everywhere", category_hint: null }, ctx);
    expect(out.prompt_hash).toMatch(/^[0-9a-f]{12}$/);
    expect(out.result.sam_prompt).toBe("fire hydrant");
    expect(sentTexts()).toEqual(expect.arrayContaining(["IMAGE R1 — resident photo", 'Optional resident note: "water everywhere"']));
  });
});
