// Author: HyeonMo Gu
// Created: 2026-11-01

import sharp from "sharp";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { offsetM } from "../geo";
import { CacheMissError } from "../meta/call";
import { sparkRespond, type ResponseItem } from "../meta/responses";
import { segment } from "../meta/sam";
import { sparkJson } from "../meta/spark";
import type { Analysis, ReportInput } from "../pipeline/analyze";
import { memoryData, type IncidentRow } from "../tools/data";
import { memoryImages, type ImageRow } from "../tools/images";
import type { CompareResult, ToolContext } from "../tools/types";
import { composeBrief } from "./brief";

vi.mock("../meta/responses", async (original) => ({ ...(await original<typeof import("../meta/responses")>()), sparkRespond: vi.fn() }));
vi.mock("../meta/spark", () => ({ sparkJson: vi.fn() }));
vi.mock("../meta/sam", () => ({ segment: vi.fn() }));

const CALL = { model: "m", key: "k", cached: false, usd: 0, ms: 0 };
const HERE = { lat: 37.5665, lng: 126.978 };
const NOW = "2026-11-01T12:00:00.000Z";

const SAME: CompareResult = {
  asset_match: { verdict: "same", confidence: 0.9, evidence: ["BAKERY sign", "bike rack"] },
  damage: { new_damage_present: true, candidate_damage_present: true, same_damage_signature: "same", repair_signs_in_new: false, evidence: [] },
  view_change: "different_angle",
  missing_info: [],
  summary: "",
};

let png: Buffer;
beforeEach(async () => {
  png ??= await sharp({ create: { width: 400, height: 300, channels: 3, background: "#777777" } }).png().toBuffer();
  vi.mocked(sparkRespond).mockReset();
  vi.mocked(sparkJson).mockReset().mockResolvedValue({ data: SAME, call: CALL });
  vi.mocked(segment).mockReset().mockResolvedValue({ boxes: [], masks: [], diagnostics: [], call: CALL } as unknown as Awaited<ReturnType<typeof segment>>);
});

/** Scripted model turns: each entry is the function calls of one response. */
function modelSays(...turns: Array<Array<[string, object]>>) {
  let i = 0;
  vi.mocked(sparkRespond).mockImplementation(async () => {
    const calls = turns[Math.min(i, turns.length - 1)]!;
    i += 1;
    const output: ResponseItem[] = calls.map(([name, args], k) => ({ type: "function_call", name, arguments: JSON.stringify(args), call_id: `c${i}_${k}` }));
    return { output, call: CALL };
  });
}

const image = (id: string, report_id: string): { row: ImageRow; bytes: Buffer } => ({
  row: { id, report_id, kind: "original", source_image_id: null, width: 400, height: 300, mime: "image/png", is_synthetic: true },
  bytes: png,
});

// App-shaped ids, so the first message can be checked for leaks.
function setup() {
  const incident: IncidentRow = {
    id: "inc_old",
    category: "fire_hydrant",
    status: "open",
    ...offsetM(HERE, 20, 0),
    title: "Cap missing",
    created_at: "2026-10-30T12:00:00.000Z",
    resolved_at: null,
    recurrence_of: null,
    representative_report_id: "rep_old",
  };
  const ctx: ToolContext = {
    reportId: "rep_new",
    runId: null,
    mode: "cached",
    budget: { usdLeft: 1, deadline: 0 },
    data: memoryData({
      asOf: NOW,
      incidents: [incident],
      events: [{ incident_id: "inc_old", at: incident.created_at, type: "created", summary: "Opened from the first resident report" }],
      photos: [{ image_id: "img_old", report_id: "rep_old", incident_id: "inc_old", observed_at: incident.created_at }],
    }),
    images: memoryImages({
      images: [image("img_new", "rep_new"), image("img_old", "rep_old")],
      incidentByReport: { rep_old: "inc_old" },
      triageByReport: { rep_new: { category: "fire_hydrant", sam_prompt: "fire hydrant" } },
    }),
  };
  const report: ReportInput = { report_id: "rep_new", image_id: "img_new", ...HERE, observed_at: NOW, description: null, category_hint: null, already_asked: false };
  const analysis: Analysis = {
    pipeline_config: "C_rules",
    prompt_hash: { triage: "t", compare: "c" },
    triage: {
      out_of_scope: false,
      category: "fire_hydrant",
      sam_prompt: "fire hydrant",
      damage_present: true,
      damage_description: "cap missing",
      repair_signs: false,
      context_landmarks: [],
      image_quality: "ok",
      severity: "medium",
    },
    segmentation: null,
    candidates: [{ incident_id: "inc_old", status: "open", created_at: incident.created_at, resolved_at: null, recurrence_of: null, distance_m: 20 }],
    comparisons: [{ incident_id: "inc_old", stage: 2, new_image_id: "img_new", candidate_image_id: "img_old", result: SAME }],
    after_fix: null,
    errors: [],
    decision: { label: "DUPLICATE", incident_id: "inc_old", rule_id: "R6a", reasons: [{ rule_id: "R6a", text: "Same hydrant, still open." }], confidence: 0.9, missing_info: [] },
    cost_usd: 0,
    latency_ms: 0,
  };
  return { ctx, report, analysis };
}

const write = (summary_refs: string[], items: Array<{ section: string; text: string; evidence_refs: string[] }>) =>
  ["write_brief", { summary: "photo_01 shows the open case incident_01.", summary_refs, items }] as [string, object];

describe("composeBrief", () => {
  it("reads a timeline, then writes a brief whose items carry real ids", async () => {
    const { ctx, report, analysis } = setup();
    modelSays(
      [["get_incident_timeline", { incident_id: "incident_01" }]],
      [
        write(
          ["fact_03"],
          [
            { section: "history", text: "incident_01 was opened from an earlier report.", evidence_refs: ["step_1"] },
            { section: "reported", text: "photo_01 shows a missing cap.", evidence_refs: ["fact_01"] },
          ],
        ),
      ],
    );
    const run = await composeBrief(report, analysis, ctx);
    expect(run.status).toBe("written");
    expect(run.steps.map((s) => [s.ref, s.tool, s.ok])).toEqual([
      ["step_1", "get_incident_timeline", true],
      ["step_2", "write_brief", true],
    ]);
    expect(run.steps[0]!.args).toEqual({ incident_id: "inc_old" });
    expect(run.brief?.items.map((i) => i.text)).toEqual(["inc_old was opened from an earlier report.", "img_new shows a missing cap."]);
    expect(run.brief?.summary).toEqual({ text: "img_new shows the open case inc_old.", evidence_refs: ["fact_03"] });
    expect(run.brief).toMatchObject({ kept: 2, dropped: 0 });
    expect(run.facts.length).toBeGreaterThan(0);
    expect(run.facts).toContainEqual({ ref: "fact_03", text: "pipeline suggestion DUPLICATE → inc_old by rule R6a: Same hydrant, still open." });
    expect(run.error).toBeNull();
  });

  it("deletes items that cite no valid evidence", async () => {
    const { ctx, report, analysis } = setup();
    modelSays([write(["fact_99"], [{ section: "photos", text: "Clearly the same hydrant.", evidence_refs: ["step_7", "fact_77"] }])]);
    const run = await composeBrief(report, analysis, ctx);
    expect(run.status).toBe("written");
    expect(run.brief).toEqual({ summary: null, items: [], kept: 0, dropped: 1 });
  });

  it("fails after the closing turn when the model never calls a tool", async () => {
    const { ctx, report, analysis } = setup();
    modelSays([]);
    const run = await composeBrief(report, analysis, ctx);
    expect(run).toMatchObject({ status: "failed", brief: null, steps: [], error: "The model answered without calling a tool." });
    expect(sparkRespond).toHaveBeenCalledTimes(2);
    const second = vi.mocked(sparkRespond).mock.calls[1]![0].tools as Array<{ name: string }>;
    expect(second.map((t) => t.name)).toEqual(["write_brief"]);
  });

  it("leaves a replay with no cached first turn to the caller", async () => {
    const { ctx, report, analysis } = setup();
    vi.mocked(sparkRespond).mockRejectedValue(new CacheMissError("no cache"));
    await expect(composeBrief(report, analysis, ctx)).rejects.toBeInstanceOf(CacheMissError);
  });

  it("shows the model numbered facts under neutral names, and no tool that decides", async () => {
    const { ctx, report, analysis } = setup();
    modelSays([write([], [])]);
    await composeBrief(report, analysis, ctx);
    const [request] = vi.mocked(sparkRespond).mock.calls[0]!;
    const user = (request.input[1] as { content: Array<{ type: string; text?: string }> }).content;
    const text = user[0]!.text!;
    expect(text).toMatch(/^REPORT report_01\nFACTS\nfact_01: category fire_hydrant/);
    expect(text).toContain("fact_03: pipeline suggestion DUPLICATE → incident_01 by rule R6a");
    expect(text).toContain("photos of incident_01 (open): photo_02 (observed 2026-10-30T12:00:00.000Z, already compared)");
    expect(text).not.toMatch(/img_|inc_|rep_/);
    expect(user[2]).toMatchObject({ type: "input_image", image_url: expect.stringContaining("data:image/png;base64,") });
    expect((request.tools as Array<{ name: string }>).map((t) => t.name)).toEqual(["search_incidents", "get_incident_timeline", "segment_object", "compare_images", "write_brief"]);
  });
});
