// Author: HyeonMo Gu
// Created: 2026-11-01

import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { eq } from "drizzle-orm";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { composeBrief, type BriefRun } from "../agent/brief";
import { ASSET_FILE } from "../dataset/static";
import { fileBlobs } from "../db/blobs";
import { openPglite } from "../db/client";
import { briefs, reportAnalyses, reports } from "../db/schema";
import { seedDemo } from "../demo/seed";
import { CacheMissError } from "../meta/call";
import { analyze, type Analysis } from "../pipeline/analyze";
import { briefReport } from "./briefs";
import { analyzeReport, createReport, reportDetail } from "./reports";
import type { Runtime } from "./runtime";

vi.mock("../pipeline/analyze", async (original) => ({ ...(await original<typeof import("../pipeline/analyze")>()), analyze: vi.fn() }));
vi.mock("../agent/brief", async (original) => ({ ...(await original<typeof import("../agent/brief")>()), composeBrief: vi.fn() }));

let rt: Runtime;

beforeAll(async () => {
  rt = { database: await openPglite(null), store: fileBlobs(await mkdtemp(path.join(tmpdir(), "civifold-"))) };
}, 60_000);

beforeEach(async () => {
  await seedDemo(rt.database, ASSET_FILE);
  vi.mocked(analyze).mockReset();
  vi.mocked(composeBrief).mockReset();
}, 30_000);

const RUN: BriefRun = {
  status: "written",
  steps: [],
  facts: [{ ref: "fact_01", text: "category fire_hydrant" }],
  brief: { summary: null, items: [{ section: "reported", text: "A hydrant.", evidence_refs: ["fact_01"] }], kept: 1, dropped: 2 },
  error: null,
  cost_usd: 0.02,
  latency_ms: 10,
};

async function analyzed() {
  const { report_id } = await createReport(rt, {
    photo: { sample_id: "syn_H1_damaged_v1_across" },
    voice: null,
    lat: 37.5665,
    lng: 126.978,
    observed_at: new Date().toISOString(),
    observed_at_source: "user",
    description: null,
    category_hint: "fire_hydrant",
    access_code: null,
  });
  vi.mocked(analyze).mockResolvedValue({
    pipeline_config: "C_rules",
    prompt_hash: { triage: "t", compare: "c" },
    triage: { out_of_scope: false, category: "fire_hydrant", sam_prompt: "fire hydrant", damage_present: true, damage_description: "cap missing", repair_signs: false, context_landmarks: [], image_quality: "ok", severity: "medium" },
    segmentation: null,
    candidates: [],
    comparisons: [],
    after_fix: null,
    errors: [],
    decision: { label: "DUPLICATE", incident_id: "inc_h1", rule_id: "R6a", missing_info: [], reasons: [], confidence: 0.9 },
    cost_usd: 0,
    latency_ms: 0,
  } as Analysis);
  await analyzeReport(rt, report_id);
  const [latest] = await rt.database.select({ id: reportAnalyses.id }).from(reportAnalyses).where(eq(reportAnalyses.report_id, report_id));
  return { report_id, analysisId: latest!.id };
}

const reportRow = async (id: string) => (await rt.database.select().from(reports).where(eq(reports.id, id)))[0]!;

describe("briefReport", () => {
  it("stores a finished brief without touching the report or its suggestion", async () => {
    const { report_id, analysisId } = await analyzed();
    const before = await reportRow(report_id);
    vi.mocked(composeBrief).mockResolvedValue(RUN);
    const result = await briefReport(rt, report_id, analysisId);
    expect(result).toMatchObject({ status: "finished", run: RUN });
    const [input, analysis] = vi.mocked(composeBrief).mock.calls[0]!;
    expect(input.report_id).toBe(report_id);
    expect(analysis.decision).toMatchObject({ label: "DUPLICATE", incident_id: "inc_h1" });
    expect(await reportRow(report_id)).toEqual(before);
    const detail = await reportDetail(rt, report_id);
    expect(detail?.briefs).toMatchObject([{ analysis_id: analysisId, requested_by: "staff", status: "written", dropped: 2, facts: RUN.facts, brief: RUN.brief }]);
    expect(detail?.analysis?.id).toBe(analysisId);
  });

  it("stores nothing when the run cannot start", async () => {
    const { report_id, analysisId } = await analyzed();
    vi.mocked(composeBrief).mockRejectedValue(new CacheMissError("no cache"));
    expect(await briefReport(rt, report_id, analysisId)).toMatchObject({ status: "not_started", reason: "no_recording" });
    expect(await rt.database.select().from(briefs).where(eq(briefs.report_id, report_id))).toEqual([]);
  });

  it("refuses an analysis that is no longer the latest", async () => {
    const { report_id, analysisId } = await analyzed();
    await expect(briefReport(rt, report_id, analysisId + 1000)).rejects.toThrow(/analyzed again/);
    expect(composeBrief).not.toHaveBeenCalled();
  });

  it("allows at most two briefs per report", async () => {
    const { report_id, analysisId } = await analyzed();
    vi.mocked(composeBrief).mockResolvedValue({ ...RUN, status: "failed", brief: null, error: "stopped" });
    await briefReport(rt, report_id, analysisId);
    await briefReport(rt, report_id, analysisId);
    await expect(briefReport(rt, report_id, analysisId)).rejects.toThrow(/had 2 briefs, the most allowed/);
    expect(composeBrief).toHaveBeenCalledTimes(2);
    expect((await reportDetail(rt, report_id))?.briefs.map((b) => [b.status, b.dropped])).toEqual([["failed", 0], ["failed", 0]]);
  });
});
