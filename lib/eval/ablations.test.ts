// Author: HyeonMo Gu
// Created: 2026-10-27

import { describe, expect, it } from "vitest";
import { offsetM } from "../geo";
import type { Analysis, ReportInput } from "../pipeline/analyze";
import { at, cand, cmp } from "../pipeline/__fixtures__/builders";
import { memoryData, type IncidentRow } from "../tools/data";
import { memoryImages } from "../tools/images";
import type { ToolContext } from "../tools/types";
import { geoBaseline, withStage } from "./ablations";

const HERE = { lat: 37.5665, lng: 126.978 };
const REPORT: ReportInput = { report_id: "r", image_id: "img_new", ...HERE, observed_at: at("+2d"), description: null, category_hint: "fire_hydrant", already_asked: false };

const incident = (id: string, northM: number, extra: Partial<IncidentRow> = {}): IncidentRow => ({
  id,
  category: "fire_hydrant",
  status: "resolved",
  ...offsetM(HERE, northM, 0),
  title: id,
  created_at: at("-3d"),
  resolved_at: at("+0d"),
  recurrence_of: null,
  representative_report_id: null,
  ...extra,
});

const ctx = (incidents: IncidentRow[]): ToolContext => ({
  reportId: "r",
  runId: null,
  mode: "cached",
  budget: { usdLeft: 0, deadline: 0 },
  data: memoryData({ asOf: at("+3d"), incidents }),
  images: memoryImages(),
});

describe("geoBaseline", () => {
  it("calls anything within the radius a duplicate of the nearest incident, repaired or not", async () => {
    const a = await geoBaseline(REPORT, ctx([incident("far", 30), incident("near", 5)]));
    expect(a.decision).toMatchObject({ label: "DUPLICATE", incident_id: "near", rule_id: "geo" });
    expect(a.cost_usd).toBe(0);
  });

  it("calls a report with nothing nearby new", async () => {
    expect((await geoBaseline(REPORT, ctx([incident("away", 200)]))).decision).toMatchObject({ label: "NEW", incident_id: null });
  });
});

describe("withStage", () => {
  // Full photos see the same hydrant; the crops are sure it is another one.
  const analysis = {
    candidates: [cand("I1", "open")],
    comparisons: [cmp("I1", "same", 0.9, { stage: 1 }), cmp("I1", "different", 0.9, { stage: 2 })],
    triage: { image_quality: "ok", out_of_scope: false },
  } as unknown as Analysis;

  it("judges by full photos only (A) or crops only (B)", () => {
    // Full photos alone never group a report (R2w): A asks for another view.
    expect(withStage(analysis, REPORT, 1).decision).toMatchObject({ label: "NEEDS_INFO", rule_id: "R2w" });
    expect(withStage(analysis, REPORT, 2).decision).toMatchObject({ label: "NEW", rule_id: "R3" });
    expect(withStage(analysis, REPORT, 1).comparisons).toHaveLength(1);
  });
});
