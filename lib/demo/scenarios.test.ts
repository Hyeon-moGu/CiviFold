// Author: HyeonMo Gu
// Created: 2026-10-29

import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { fileBlobs } from "../db/blobs";
import { openPglite } from "../db/client";
import { ASSET_FILE } from "../dataset/static";
import { analyze, type Analysis } from "../pipeline/analyze";
import type { Runtime } from "../server/runtime";
import { demoState, runStep, SCENARIOS } from "./scenarios";
import { seedDemo } from "./seed";

vi.mock("../pipeline/analyze", async (original) => ({ ...(await original<typeof import("../pipeline/analyze")>()), analyze: vi.fn() }));

let rt: Runtime;

beforeAll(async () => {
  rt = { database: await openPglite(null), store: fileBlobs(await mkdtemp(path.join(tmpdir(), "civifold-"))) };
}, 60_000);

beforeEach(async () => {
  await seedDemo(rt.database, ASSET_FILE);
  vi.mocked(analyze).mockReset();
}, 30_000);

function fastSays(label: "NEW" | "LATE_REPORT", incident_id: string | null) {
  vi.mocked(analyze).mockResolvedValue({
    pipeline_config: "C_rules",
    prompt_hash: { triage: "t", compare: "c" },
    triage: { out_of_scope: false, category: "fire_hydrant", sam_prompt: "fire hydrant", damage_present: true, damage_description: "cap missing", repair_signs: false, context_landmarks: [], image_quality: "ok", severity: "medium" },
    segmentation: null,
    candidates: [],
    comparisons: [],
    after_fix: null,
    errors: [],
    decision: { label, incident_id, rule_id: "R1", missing_info: [], reasons: [], confidence: 0.9 },
    cost_usd: 0,
    latency_ms: 0,
  } as Analysis);
}

describe("demo scenarios", () => {
  it("gives every scenario that records a repair that incident to itself", () => {
    const repaired = SCENARIOS.flatMap((s) => s.steps.flatMap((st) => (st.kind === "repair" ? [st.asset] : [])));
    expect(repaired.length).toBeGreaterThan(0);
    for (const asset of repaired) expect(SCENARIOS.filter((s) => s.world.includes(asset))).toHaveLength(1);
  });

  it("reads back what each step has done, so progress survives a page change", async () => {
    expect(await demoState(rt)).toEqual({});
    fastSays("NEW", null);
    const sent = (await runStep(rt, "lookalike", 0)) as { report_id: string; tracking_code: string; label: string };
    expect(sent.label).toBe("NEW");
    await runStep(rt, "after-repair", 0);
    const state = await demoState(rt);
    expect(state["lookalike:0"]).toEqual({ report_id: sent.report_id, tracking_code: sent.tracking_code, label: "NEW" });
    expect(state["after-repair:0"]).toEqual({ done: "Staff record yesterday's repair" });
    expect(state["after-repair:1"]).toBeUndefined();
    expect(state["duplicate:0"]).toBeUndefined();
  });

  it("asks for a reset when the world a step expects has moved on", async () => {
    await runStep(rt, "after-repair", 0);
    await expect(runStep(rt, "after-repair", 0)).rejects.toThrow(/Reset the demo/);
  });
});
