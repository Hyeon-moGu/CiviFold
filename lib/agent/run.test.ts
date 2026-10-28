// Author: HyeonMo Gu
// Created: 2026-10-27

import sharp from "sharp";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { offsetM } from "../geo";
import { memoryStore, setCacheStore } from "../meta/cache";
import { CacheMissError, LiveBudgetError, metaCall } from "../meta/call";
import { sparkRespond, type ResponseItem } from "../meta/responses";
import { segment } from "../meta/sam";
import { sparkJson } from "../meta/spark";
import type { Analysis, ReportInput } from "../pipeline/analyze";
import { memoryData, type IncidentRow } from "../tools/data";
import { memoryImages, type ImageRow } from "../tools/images";
import type { CompareResult, ToolContext } from "../tools/types";
import { AGENT_LIMITS } from "../pipeline/config";
import { investigate } from "./run";

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

function setup(already_asked = false) {
  const incident: IncidentRow = {
    id: "I1",
    category: "fire_hydrant",
    status: "open",
    ...offsetM(HERE, 60, 0), // outside the fast path's 40 m: the agent has to widen the search
    title: "I1",
    created_at: "2026-10-30T12:00:00.000Z",
    resolved_at: null,
    recurrence_of: null,
    representative_report_id: "r_I1",
  };
  const ctx: ToolContext = {
    reportId: "r_new",
    runId: "run_1",
    mode: "cached",
    budget: { usdLeft: 1, deadline: 0 },
    data: memoryData({ asOf: NOW, incidents: [incident], photos: [{ image_id: "img_I1", report_id: "r_I1", incident_id: "I1", observed_at: incident.created_at }] }),
    images: memoryImages({
      images: [image("img_new", "r_new"), image("img_I1", "r_I1")],
      incidentByReport: { r_I1: "I1" },
      triageByReport: { r_new: { category: "fire_hydrant", sam_prompt: "fire hydrant" } },
    }),
  };
  const report: ReportInput = { report_id: "r_new", image_id: "img_new", ...HERE, observed_at: NOW, description: null, category_hint: null, already_asked };
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
    candidates: [],
    comparisons: [],
    after_fix: null,
    errors: [],
    decision: { label: "HUMAN_REVIEW", incident_id: null, rule_id: "R5", reasons: [{ rule_id: "R5", text: "Unsure." }], confidence: 0, missing_info: [] },
    cost_usd: 0,
    latency_ms: 0,
  };
  return { ctx, report, analysis };
}

const search = (radius_m: number) => ["search_incidents", { lat: HERE.lat, lng: HERE.lng, radius_m, days_back: 90, category: null }] as [string, object];
const compare = ["compare_images", { new_image_id: "img_new", candidate_image_id: "img_I1", mode: "crops" }] as [string, object];
const propose = (label: string, incident_id: string | null, evidence_refs: string[]) =>
  ["propose_decision", { label, incident_id, confidence: 0.8, evidence_refs, rationale: "" }] as [string, object];

describe("investigate", () => {
  it("widens the search, compares, and has its proposal checked by the guardrail", async () => {
    const { ctx, report, analysis } = setup();
    // SAM finds the hydrant in both photos, so the comparison is a real crop comparison.
    const box = { kind: "box", order: 0, objectId: "a", left: 150, top: 100, right: 250, bottom: 200, confidence: 0.9 };
    vi.mocked(segment).mockResolvedValue({ boxes: [box], masks: [], diagnostics: [], call: CALL } as unknown as Awaited<ReturnType<typeof segment>>);
    modelSays([search(120)], [compare], [propose("DUPLICATE", "I1", ["step_1", "step_2"])]);
    const run = await investigate(report, analysis, ctx);
    expect(run.status).toBe("proposed");
    expect(run.final).toEqual({ label: "DUPLICATE", incident_id: "I1", missing_info: [] });
    expect(run.steps.map((s) => [s.ref, s.tool, s.ok])).toEqual([
      ["step_1", "search_incidents", true],
      ["step_2", "compare_images", true],
      ["step_3", "propose_decision", true],
    ]);
    expect(run.guard).toMatchObject({ passed: true, decide_label: "DUPLICATE" });
  });

  it("finishes the run when whoever watches its steps fails", async () => {
    const { ctx, report, analysis } = setup();
    modelSays([search(120)], [propose("HUMAN_REVIEW", null, [])]);
    const run = await investigate(report, analysis, ctx, AGENT_LIMITS, () => {
      throw new TypeError("Invalid state: Controller is already closed");
    });
    expect(run.status).not.toBe("failed");
    expect(run.steps.map((s) => s.tool)).toEqual(["search_incidents", "propose_decision"]);
  });

  it("blocks a duplicate resting on a crop request that fell back to full photos", async () => {
    const { ctx, report, analysis } = setup();
    modelSays([search(120)], [compare], [propose("DUPLICATE", "I1", ["step_1", "step_2"])]);
    const run = await investigate(report, analysis, ctx);
    expect(run).toMatchObject({ status: "blocked", guard: { blocked_rules: ["G4"] } });
  });

  it("sends the report to staff when the guardrail blocks the proposal", async () => {
    const { ctx, report, analysis } = setup();
    modelSays([search(120)], [propose("DUPLICATE", "I1", ["step_1"])]);
    const run = await investigate(report, analysis, ctx);
    expect(run.status).toBe("blocked");
    expect(run.final.label).toBe("HUMAN_REVIEW");
    expect(run.guard?.blocked_rules).toEqual(["G1"]);
  });

  it("fails to staff when the model answers without a tool", async () => {
    const { ctx, report, analysis } = setup();
    modelSays([]);
    const run = await investigate(report, analysis, ctx);
    expect(run).toMatchObject({ status: "failed", final: { label: "HUMAN_REVIEW" }, steps: [] });
  });

  it("asks for a proposal once when the model stops calling tools", async () => {
    const { ctx, report, analysis } = setup();
    modelSays([], [propose("HUMAN_REVIEW", null, [])]);
    const run = await investigate(report, analysis, ctx);
    expect(run.status).toBe("proposed");
    const second = vi.mocked(sparkRespond).mock.calls[1]![0].tools as Array<{ name: string }>;
    expect(second.map((t) => t.name)).toEqual(["propose_decision"]);
  });

  it("offers only the terminal tools on the last step and stops at the step limit", async () => {
    const { ctx, report, analysis } = setup();
    const n = AGENT_LIMITS.max_steps;
    modelSays(...Array.from({ length: n + 3 }, (_, i) => [search(50 + 10 * i)]));
    const run = await investigate(report, analysis, ctx, { ...AGENT_LIMITS, max_usd: 10 });
    expect(run.status).toBe("budget_exceeded");
    expect(run.final.label).toBe("HUMAN_REVIEW");
    // The last step stays free for a proposal; searches past it are answered, not run, and after a
    // reminder and two refusals the run ends.
    expect(run.steps).toHaveLength(n - 1);
    expect(sparkRespond).toHaveBeenCalledTimes(n + 1);
    const lastTools = vi.mocked(sparkRespond).mock.calls.at(-1)![0].tools as Array<{ name: string }>;
    expect(lastTools.map((t) => t.name)).toEqual(["propose_decision"]);
  });

  it("offers only the terminal tools once little time is left", async () => {
    const { ctx, report, analysis } = setup();
    modelSays([search(50)]);
    await investigate(report, analysis, ctx, { ...AGENT_LIMITS, max_ms: 5_000, closing_ms: 10_000 });
    const firstTools = vi.mocked(sparkRespond).mock.calls[0]![0].tools as Array<{ name: string }>;
    expect(firstTools.map((t) => t.name)).toEqual(["propose_decision"]);
  });

  it("keeps the last step for a proposal when one turn asks for several tools", async () => {
    const { ctx, report, analysis } = setup();
    const n = AGENT_LIMITS.max_steps;
    modelSays(Array.from({ length: n + 2 }, (_, i) => search(50 + 10 * i)), [propose("HUMAN_REVIEW", null, [])]);
    const run = await investigate(report, analysis, ctx, { ...AGENT_LIMITS, max_usd: 10 });
    expect(run.steps.map((s) => s.tool)).toEqual([...Array(n - 1).fill("search_incidents"), "propose_decision"]);
    expect(run.status).toBe("proposed");
  });

  it("does not run a proposal that arrives after the time limit", async () => {
    const { ctx, report, analysis } = setup();
    vi.mocked(sparkRespond).mockImplementation(async () => {
      await new Promise((r) => setTimeout(r, 30));
      return { output: [{ type: "function_call", name: "propose_decision", arguments: JSON.stringify(propose("HUMAN_REVIEW", null, [])[1]), call_id: "c1" }], call: CALL };
    });
    const run = await investigate(report, analysis, ctx, { ...AGENT_LIMITS, max_usd: 1, max_ms: 20 });
    expect(run).toMatchObject({ status: "budget_exceeded", steps: [], proposal: null });
  });

  it("stops waiting for a model turn at the deadline and keeps what it has", async () => {
    const { ctx, report, analysis } = setup();
    vi.mocked(sparkRespond).mockImplementation(() => new Promise(() => {}));
    const started = Date.now();
    const run = await investigate(report, analysis, ctx, { ...AGENT_LIMITS, max_usd: 1, max_ms: 30 });
    expect(Date.now() - started).toBeLessThan(1000);
    expect(run).toMatchObject({ status: "budget_exceeded", final: { label: "HUMAN_REVIEW" } });
    expect(run.error).toMatch(/time limit/);
  });

  it("records a model failure as a failed run instead of throwing", async () => {
    const { ctx, report, analysis } = setup();
    modelSays([search(60)]);
    vi.mocked(sparkRespond).mockResolvedValueOnce({ output: [{ type: "function_call", name: "search_incidents", arguments: JSON.stringify(search(60)[1]), call_id: "c1" }], call: CALL });
    vi.mocked(sparkRespond).mockRejectedValueOnce(new Error("HTTP 500 after retries"));
    const run = await investigate(report, analysis, ctx);
    expect(run).toMatchObject({ status: "failed", error: "HTTP 500 after retries" });
    expect(run.steps).toHaveLength(1);
  });

  it("allows the same comparison again after an image was segmented again", async () => {
    const { ctx, report, analysis } = setup();
    const resegment = ["segment_object", { image_id: "img_new", noun_phrase: "hydrant" }] as [string, object];
    modelSays([compare], [resegment], [compare], [propose("HUMAN_REVIEW", null, [])]);
    const run = await investigate(report, analysis, ctx);
    expect(run.steps.map((s) => [s.tool, s.ok])).toEqual([["compare_images", true], ["segment_object", true], ["compare_images", true], ["propose_decision", true]]);
  });

  it("keeps the steps so far when the daily budget runs out mid-run", async () => {
    const { ctx, report, analysis } = setup();
    vi.mocked(sparkRespond).mockResolvedValueOnce({ output: [{ type: "function_call", name: "search_incidents", arguments: JSON.stringify(search(60)[1]), call_id: "c1" }], call: CALL });
    vi.mocked(sparkRespond).mockRejectedValueOnce(new LiveBudgetError("today's budget is used up"));
    const run = await investigate(report, analysis, ctx);
    expect(run).toMatchObject({ status: "budget_exceeded", final: { label: "HUMAN_REVIEW" } });
    expect(run.steps).toHaveLength(1);
  });

  it("keeps a tool's step and its paid SAM call when the budget runs out inside the tool", async () => {
    const { ctx, report, analysis } = setup();
    setCacheStore(memoryStore());
    vi.mocked(segment).mockImplementation(async () => {
      await metaCall({ model: "sam-3.1", request: { n: Math.random() }, send: async () => "ok", cost: () => 0.0025, mode: "live" });
      return { boxes: [], masks: [], diagnostics: [], call: CALL } as unknown as Awaited<ReturnType<typeof segment>>;
    });
    vi.mocked(sparkJson).mockRejectedValue(new LiveBudgetError("today's budget is used up"));
    modelSays([compare]);
    const run = await investigate(report, analysis, ctx);
    expect(run).toMatchObject({ status: "budget_exceeded", error: "today's budget is used up" });
    expect(run.steps).toHaveLength(1);
    expect(run.steps[0]).toMatchObject({ tool: "compare_images", ok: false });
    expect(run.steps[0]!.usd).toBeCloseTo(0.005); // SAM on both photos
    expect(run.cost_usd).toBeCloseTo(0.005);
  });

  it("leaves a replay with no cached first turn to the caller", async () => {
    const { ctx, report, analysis } = setup();
    vi.mocked(sparkRespond).mockRejectedValue(new CacheMissError("no cache"));
    await expect(investigate(report, analysis, ctx)).rejects.toBeInstanceOf(CacheMissError);
  });

  it("answers a repeated call with an error instead of running it again", async () => {
    const { ctx, report, analysis } = setup();
    modelSays([compare], [compare], [propose("HUMAN_REVIEW", null, [])]);
    const run = await investigate(report, analysis, ctx);
    expect(run.steps[1]).toMatchObject({ ok: false, error: "duplicate_call: same as step_1" });
    expect(vi.mocked(sparkJson)).toHaveBeenCalledTimes(1);
  });

  it("does not offer ask_resident: questions come from the rules", async () => {
    const { ctx, report, analysis } = setup();
    modelSays([["ask_resident", { question: "Another photo?", requested_items: ["close_up"], reason_for_staff: "" }]], [propose("HUMAN_REVIEW", null, [])]);
    const run = await investigate(report, analysis, ctx);
    const offered = vi.mocked(sparkRespond).mock.calls[0]![0].tools as Array<{ name: string }>;
    expect(offered.map((t) => t.name)).not.toContain("ask_resident");
    expect(run.steps[0]).toMatchObject({ ok: false, error: expect.stringMatching(/not available/) });
    expect(run).toMatchObject({ status: "proposed", final: { label: "HUMAN_REVIEW" } });
  });

  it("puts the report photo and the pipeline's doubt in the first message", async () => {
    const { ctx, report, analysis } = setup();
    modelSays([propose("HUMAN_REVIEW", null, [])]);
    await investigate(report, analysis, ctx);
    const input = vi.mocked(sparkRespond).mock.calls[0]![0].input as Array<{ role: string; content: unknown }>;
    const user = JSON.stringify(input[1]);
    expect(user).toContain("blocked_rule: R5");
    expect(user).toContain("photos of this report (use as new_image_id): photo_01");
    expect(user).not.toMatch(/img_new|img_I1|r_new|"I1"/);
    expect(user).toContain("data:image/png;base64,");
  });

  it("shows the model neutral names and runs its calls on the real ids", async () => {
    const { ctx, report, analysis } = setup();
    modelSays([["compare_images", { new_image_id: "photo_01", candidate_image_id: "photo_02", mode: "full" }]], [propose("HUMAN_REVIEW", null, [])]);
    const run = await investigate(report, analysis, ctx);
    expect(run.steps[0]).toMatchObject({ tool: "compare_images", ok: true, args: { new_image_id: "img_new", candidate_image_id: "img_I1" } });
    const second = JSON.stringify(vi.mocked(sparkRespond).mock.calls[1]![0].input);
    expect(second).toContain("function_call_output");
    expect(second).not.toMatch(/img_new|img_I1/);
  });
});
