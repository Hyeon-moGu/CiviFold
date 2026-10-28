// Author: HyeonMo Gu
// Created: 2026-10-27

import sharp from "sharp";
import { describe, expect, it } from "vitest";
import { imagePlan, loadAssets, type AssetFile } from "../dataset/assets";
import { haversineM } from "../geo";
import { assetLocation, at, buildCases, REPAIR_DAY, TRANSFORMS } from "./cases";
import type { Label } from "../tools/types";
import { degrade } from "./degrade";
import { classify, stages, summarize, type ScoredCase } from "./metrics";
import { worldAt } from "./world";

const file: AssetFile = await loadAssets();
const cases = buildCases(file);

describe("buildCases", () => {
  it("builds 357 base and 144 stress cases, 56 of them in dev", () => {
    expect(cases.filter((c) => c.set === "base")).toHaveLength(357);
    expect(cases.filter((c) => c.set === "stress")).toHaveLength(144);
    expect(cases.filter((c) => c.split === "dev")).toHaveLength(56);
    expect(cases.filter((c) => c.split === "val")).toHaveLength(56);
    expect(cases.filter((c) => c.split === "test")).toHaveLength(110);
    expect(cases.filter((c) => c.split === "holdout")).toHaveLength(55);
    expect(cases.filter((c) => c.split === "holdout2")).toHaveLength(112);
    expect(cases.filter((c) => c.split === "holdout3")).toHaveLength(112);
    expect(new Set(cases.map((c) => c.id)).size).toBe(cases.length);
  });

  it("puts every report up to 15 m off, the same way on every build", () => {
    const byId = new Map(file.assets.map((a) => [a.id, a]));
    const noisy = cases.filter((c) => !c.kind.startsWith("gps-"));
    const offsets = noisy.map((c) => haversineM(c.location, assetLocation(file, byId.get(c.asset_id)!)));
    expect(Math.max(...offsets)).toBeLessThanOrEqual(15.01);
    expect(offsets.filter((m) => m > 1).length).toBeGreaterThan(noisy.length * 0.8);
    expect(buildCases(file)).toEqual(cases);
  });

  it("keeps the special GPS errors at their fixed distances", () => {
    const byId = new Map(file.assets.map((a) => [a.id, a]));
    const off = (id: string) => {
      const c = cases.find((x) => x.id === id)!;
      return haversineM(c.location, assetLocation(file, byId.get(c.asset_id)!));
    };
    expect(off("S1-gps-small")).toBeCloseTo(25, 0);
    expect(off("H2-gps-large-t2")).toBeCloseTo(80, 0);
  });

  it("gives every main asset two night and two degraded stress reports, using every transform", () => {
    const stress = cases.filter((c) => c.set === "stress");
    expect(stress.filter((c) => c.asset_id === "W1").map((c) => c.kind)).toEqual(["t2-night", "t6-night", expect.stringMatching(/^t2-/), expect.stringMatching(/^t6-/)]);
    expect(new Set(stress.flatMap((c) => (c.transform ? [c.transform] : [])))).toEqual(new Set(TRANSFORMS));
  });

  it("only uses images the dataset plan produces", () => {
    const byId = new Map(file.assets.map((a) => [a.id, a]));
    const planned = new Set(file.assets.flatMap((a) => imagePlan(a, a.pair_of ? byId.get(a.pair_of)! : null).map((s) => s.id)));
    for (const c of cases) {
      for (const id of [c.image_id, c.answers.wider_context, c.answers.close_up]) expect(planned, `${c.id} uses ${id}`).toContain(id);
    }
  });

  // A resident's answer must be a second observation: comparing a photo with itself proves nothing.
  it("never answers with the reported photo or one the incident already holds", () => {
    // The world depends only on the time, and the cases share a few submission times.
    const heldAt = new Map<string, Set<string>>();
    for (const c of cases) {
      let held = heldAt.get(c.submitted_at);
      if (!held) heldAt.set(c.submitted_at, (held = new Set(worldAt(file, c.submitted_at).photos.map((p) => p.image_id))));
      for (const [item, id] of Object.entries(c.answers)) {
        expect(id, `${c.id} ${item}`).not.toBe(c.image_id);
        expect(held.has(id), `${c.id} ${item} answers with ${id}, already in the world`).toBe(false);
      }
    }
  });

  it("expects look-alikes to open new incidents", () => {
    expect(cases.filter((c) => c.kind.startsWith("lookalike")).every((c) => c.expected.label === "NEW")).toBe(true);
  });

  it("states a post-repair time for a time-conflict report and answers with the real one", () => {
    const c = cases.find((x) => x.id === "H1-time-conflict")!;
    expect(Date.parse(c.observed_at)).toBeGreaterThan(Date.parse(at(REPAIR_DAY)));
    expect(Date.parse(c.true_observed_at)).toBeLessThan(Date.parse(at(REPAIR_DAY)));
    expect(c.expected).toEqual({ label: "LATE_REPORT", incident: "H1/I1" });
  });
});

describe("worldAt", () => {
  const h1 = (asOf: string) => {
    const w = worldAt(file, asOf);
    return { w, incidents: w.incidents.filter((i) => i.id.startsWith("H1/")), photos: w.photos.filter((p) => p.incident_id.startsWith("H1/")) };
  };

  it("is empty before the first report arrives", () => {
    expect(worldAt(file, at(0)).incidents).toEqual([]);
  });

  it("holds an open incident with the reports linked so far", () => {
    const { incidents, photos } = h1(at(1));
    expect(incidents).toMatchObject([{ id: "H1/I1", status: "open", resolved_at: null, representative_report_id: "H1#1" }]);
    expect(photos.map((p) => p.image_id)).toEqual(["syn_H1_damaged_v1_front"]);
  });

  it("marks the incident resolved after the repair and adds the recurrence later", () => {
    expect(h1(at(4)).incidents).toMatchObject([{ id: "H1/I1", status: "resolved", resolved_at: at(REPAIR_DAY) }]);
    const { incidents, photos } = h1(at(21));
    expect(incidents.map((i) => [i.id, i.status, i.recurrence_of])).toEqual([["H1/I1", "resolved", null], ["H1/I2", "open", "H1/I1"]]);
    expect(photos.filter((p) => p.incident_id === "H1/I2").map((p) => p.image_id)).toEqual(["syn_H1_damaged_v2_front"]);
  });

  it("never contains look-alikes", () => {
    expect(worldAt(file, at(30)).incidents.some((i) => i.id.startsWith("H5"))).toBe(false);
  });
});

describe("classify", () => {
  const e = (label: Parameters<typeof classify>[0]["label"], incident: string | null = null) => ({ label, incident });
  it.each([
    ["correct link", e("DUPLICATE", "A/I1"), e("DUPLICATE", "A/I1"), "correct"],
    ["right label, wrong incident", e("DUPLICATE", "A/I1"), e("DUPLICATE", "B/I1"), "critical"],
    ["look-alike buried as duplicate", e("NEW"), e("DUPLICATE", "A/I1"), "critical"],
    ["recurrence buried as resolved", e("POSSIBLE_RECURRENCE", "A/I1"), e("ALREADY_RESOLVED", "A/I1"), "critical"],
    ["duplicate opened as new", e("DUPLICATE", "A/I1"), e("NEW"), "safe_error"],
    ["new flagged as recurrence", e("NEW"), e("POSSIBLE_RECURRENCE", "A/I1"), "safe_error"],
    ["deferred to staff", e("LATE_REPORT", "A/I1"), e("HUMAN_REVIEW"), "deferred"],
    ["still asking", e("NEW"), e("NEEDS_INFO"), "deferred"],
  ] as const)("%s", (_, expected, predicted, outcome) => {
    expect(classify(expected, predicted)).toBe(outcome);
  });
});

describe("summarize", () => {
  it("computes the headline rates", () => {
    const scored = (exp: ScoredCase["expected"], pred: ScoredCase["predicted"], asked: string | null = null): ScoredCase => ({
      expected: exp,
      predicted: pred,
      outcome: classify(exp, pred),
      asked,
      cost_usd: 0.1,
      latency_ms: 2000,
    });
    const s = summarize([
      scored({ label: "DUPLICATE", incident: "A/I1" }, { label: "DUPLICATE", incident: "A/I1" }),
      scored({ label: "LATE_REPORT", incident: "A/I1" }, { label: "HUMAN_REVIEW", incident: null }, "observed_time"),
      scored({ label: "NEW", incident: null }, { label: "DUPLICATE", incident: "A/I1" }),
      scored({ label: "NEW", incident: null }, { label: "NEW", incident: null }),
    ]);
    expect(s.outcomes).toEqual({ correct: 2, deferred: 1, safe_error: 0, critical: 1 });
    expect(s.critical_miss_rate).toBe(0.5);
    expect(s.review_reduction).toBe(0.25);
    expect(s.dup_precision).toBe(0.5);
    expect(s.dup_recall).toBe(0.5);
    expect(s.question_rate).toBe(0.25);
    expect(s.staff_review_if_no_answer).toBe(0.25);
    expect(s.usd_per_report).toBeCloseTo(0.1);
    expect(s.confusion.NEW).toEqual({ DUPLICATE: 1, NEW: 1 });
  });
});

describe("stages", () => {
  const scored = (expected: Label, predicted: Label, asked: ScoredCase["asked"]): ScoredCase => {
    const e = { label: expected, incident: expected === "NEW" ? null : "A/I1" };
    const p = { label: predicted, incident: predicted === "NEW" ? null : "A/I1" };
    return { expected: e, predicted: p, outcome: classify(e, p), asked, cost_usd: 0, latency_ms: 0 };
  };

  it("counts an asked report as deferred until the resident answers", () => {
    const s = stages([
      scored("DUPLICATE", "DUPLICATE", null),
      scored("DUPLICATE", "DUPLICATE", "wider_context"),
      scored("NEW", "DUPLICATE", "close_up"),
      scored("POSSIBLE_RECURRENCE", "HUMAN_REVIEW", "close_up"),
    ]);
    expect(s.first_or_no_answer).toMatchObject({ correct: 1, deferred: 3, critical: 0, critical_miss_rate: 0 });
    expect(s.after_answer).toMatchObject({ correct: 2, deferred: 1, critical: 1, critical_miss_rate: 0.5 });
    expect(s.asked).toBe(3);
    expect(s.answer_effect).toEqual({ correct: 1, still_deferred: 1, safe_error: 0, critical: 1 });
  });
});

describe("degrade", () => {
  it("spoils a photo deterministically in every way", async () => {
    const photo = await sharp({ create: { width: 960, height: 640, channels: 3, background: "#6688aa" } }).webp().toBuffer();
    for (const t of TRANSFORMS) {
      const a = await degrade(photo, t);
      const b = await degrade(photo, t);
      expect(a.bytes.equals(b.bytes), t).toBe(true);
    }
    expect((await degrade(photo, "low_res")).width).toBe(480);
    expect((await degrade(photo, "off_center")).width).toBe(624);
    expect((await degrade(photo, "jpeg")).mime).toBe("image/jpeg");
  });
});
