// Author: HyeonMo Gu
// Created: 2026-10-29

import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { eq } from "drizzle-orm";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { fileBlobs } from "../db/blobs";
import { openPglite } from "../db/client";
import { reports } from "../db/schema";
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

type Sent = { report_id: string; tracking_code: string; label: string };

function fastSays(label: "NEW" | "LATE_REPORT" | "DUPLICATE", incident_id: string | null) {
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
    const sent = (await runStep(rt, "lookalike", 0)) as Sent;
    expect(sent.label).toBe("NEW");
    await runStep(rt, "after-repair", 0);
    const state = await demoState(rt);
    // No incident among the analysis' candidates: the location-only rule would call it new as well.
    expect(state["lookalike:0"]).toEqual({
      report_id: sent.report_id,
      tracking_code: sent.tracking_code,
      label: "NEW",
      incident_id: null,
      location_only: { label: "NEW", incident_id: null },
    });
    expect(state["after-repair:0"]).toEqual({ done: "Staff record yesterday's repair" });
    expect(state["after-repair:1"]).toBeUndefined();
    expect(state["duplicate:0"]).toBeUndefined();
  });

  it("keeps agent steps off an incident once a staff decision has linked a report to it", () => {
    const agent = (kind: string) => kind === "verify" || kind === "brief";
    for (const s of SCENARIOS) {
      const at = s.steps.findIndex((st) => st.kind === "decide");
      if (at < 0) continue;
      expect(s.steps.slice(at).some((st) => agent(st.kind))).toBe(false);
      for (const other of SCENARIOS.filter((o) => o !== s && o.world.some((a) => s.world.includes(a)))) {
        expect(other.steps.some((st) => agent(st.kind)), other.id).toBe(false);
      }
    }
  });

  it("links the report when staff approve, and later report steps on that incident still run", async () => {
    const decide = SCENARIOS.find((s) => s.id === "duplicate")!.steps.findIndex((st) => st.kind === "decide");
    expect(decide).toBe(3);
    fastSays("DUPLICATE", "inc_h1");
    const sent = (await runStep(rt, "duplicate", 0)) as Sent;
    expect(sent.label).toBe("DUPLICATE");
    const decided = { report_id: sent.report_id, tracking_code: sent.tracking_code, decided: { action: "link", incident_id: "inc_h1" } };
    expect(await runStep(rt, "duplicate", decide)).toEqual(decided);
    const [row] = await rt.database.select({ status: reports.status, incident_id: reports.incident_id }).from(reports).where(eq(reports.id, sent.report_id));
    expect(row).toEqual({ status: "linked", incident_id: "inc_h1" });
    const state = await demoState(rt);
    expect(state[`duplicate:${decide}`]).toEqual(decided);
    expect(state["duplicate:1"]).toBeUndefined();

    // The fast path compares the incident's first photo only, which a link does not change; an agent reads the linked photo too.
    fastSays("NEW", null);
    expect(await runStep(rt, "lookalike", 0)).toMatchObject({ label: "NEW" });
    await expect(runStep(rt, "duplicate", 1)).rejects.toThrow(/Reset the demo/);
    await expect(runStep(rt, "duplicate", decide)).rejects.toThrow(/nothing to decide now/);
  });

  it("refuses to approve a suggestion that names no incident", async () => {
    fastSays("NEW", null);
    await runStep(rt, "duplicate", 0);
    await expect(runStep(rt, "duplicate", 3)).rejects.toThrow(/names no incident/);
  });

  it("asks for a reset when the world a step expects has moved on", async () => {
    await runStep(rt, "after-repair", 0);
    await expect(runStep(rt, "after-repair", 0)).rejects.toThrow(/Reset the demo/);
  });
});
