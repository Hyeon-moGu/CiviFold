// Author: HyeonMo Gu
// Created: 2026-10-29

import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { eq, inArray } from "drizzle-orm";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { fileBlobs } from "../db/blobs";
import { openPglite } from "../db/client";
import { images, incidents, reports } from "../db/schema";
import { REAL_PAIRS } from "../dataset/real";
import { ASSET_FILE } from "../dataset/static";
import { analyze, type Analysis } from "../pipeline/analyze";
import type { Runtime } from "../server/runtime";
import { agentCheckOf, agentRecorded, demoState, runStep, SCENARIOS } from "./scenarios";
import { seedDemo, seedIncidentId } from "./seed";

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
      seen: [],
    });
    expect(state["after-repair:0"]).toEqual({ done: "Staff record yesterday's repair" });
    expect(state["after-repair:1"]).toBeUndefined();
    expect(state["duplicate:0"]).toBeUndefined();
  });

  it("keeps agent steps before a staff decision in their scenario", () => {
    const agent = (kind: string) => kind === "verify" || kind === "brief";
    for (const s of SCENARIOS) {
      const at = s.steps.findIndex((st) => st.kind === "decide");
      if (at >= 0) expect(s.steps.slice(at).some((st) => agent(st.kind))).toBe(false);
    }
  });

  it("turns off another scenario's replayed agent once staff link a report to the incident it reads", async () => {
    fastSays("NEW", null);
    const sent = (await runStep(rt, "lookalike", 0)) as Sent;
    const [report] = await rt.database.select({ dataset_case_id: reports.dataset_case_id, lat: reports.lat, lng: reports.lng }).from(reports).where(eq(reports.id, sent.report_id));
    await runStep(rt, "after-repair", 0);
    expect(await agentRecorded(rt, report!, "brief")).toBe(true);
    fastSays("DUPLICATE", "inc_h1");
    await runStep(rt, "duplicate", 0);
    await runStep(rt, "duplicate", 3);
    expect(await agentRecorded(rt, report!, "brief")).toBe(false);
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
    await expect(runStep(rt, "duplicate", 1)).rejects.toThrow(/Reset it to the start/);
    await expect(runStep(rt, "duplicate", decide)).rejects.toThrow(/nothing to decide now/);
  });

  it("offers a replayed agent only where the world is still as its run was recorded", async () => {
    fastSays("DUPLICATE", "inc_h1");
    const sent = (await runStep(rt, "duplicate", 0)) as Sent;
    const [report] = await rt.database.select({ dataset_case_id: reports.dataset_case_id, lat: reports.lat, lng: reports.lng }).from(reports).where(eq(reports.id, sent.report_id));
    // The run was recorded at the end of a play, when the hydrant by the FLOWERS, 209 m away, was repaired; the
    // agent searches up to 300 m.
    expect(await agentRecorded(rt, report!, "verify")).toBe(false);
    await runStep(rt, "after-repair", 0);
    expect(await agentRecorded(rt, report!, "verify")).toBe(true);
    expect(await agentRecorded(rt, report!, "brief")).toBe(true);
    // No scenario records an agent on these reports, and a resident's own report is never a demo step.
    expect(await agentRecorded(rt, { ...report!, dataset_case_id: "demo:lookalike:0" }, "verify")).toBe(false);
    expect(await agentRecorded(rt, { ...report!, dataset_case_id: null }, "verify")).toBe(false);
  });

  it("offers no replayed agent once staff link a report to the incident it reads", async () => {
    fastSays("DUPLICATE", "inc_h1");
    const sent = (await runStep(rt, "duplicate", 0)) as Sent;
    const [report] = await rt.database.select({ dataset_case_id: reports.dataset_case_id, lat: reports.lat, lng: reports.lng }).from(reports).where(eq(reports.id, sent.report_id));
    await runStep(rt, "after-repair", 0);
    expect(await agentRecorded(rt, report!, "verify")).toBe(true);
    await runStep(rt, "duplicate", 3);
    expect(await agentRecorded(rt, report!, "verify")).toBe(false);
  });

  it("runs a visitor's send live while today's budget holds a whole analysis, and the play's sends replay", async () => {
    fastSays("NEW", null);
    const liveOf = async (id: string) => (await rt.database.select({ live: reports.live }).from(reports).where(eq(reports.id, id)))[0]!.live;
    vi.stubEnv("LIVE_DAILY_USD", "5");
    expect(await liveOf(((await runStep(rt, "lookalike", 0, { live: true })) as Sent).report_id)).toBe(true);
    expect(await liveOf(((await runStep(rt, "lookalike", 0)) as Sent).report_id)).toBe(false);
    vi.stubEnv("LIVE_DAILY_USD", "0");
    expect(await liveOf(((await runStep(rt, "lookalike", 0, { live: true })) as Sent).report_id)).toBe(false);
    vi.unstubAllEnvs();
  });

  it("counts what the verification agent checked as the staff view does", () => {
    const compare = (incident: string, verdict: string, problem = "same") => ({
      ok: true,
      tool: "compare_images",
      data: { asset_match: { verdict }, damage: { same_damage_signature: problem }, candidate_incident_id: incident },
    });
    const steps = [
      { ok: true, tool: "search_incidents" },
      compare("inc_h1", "same"),
      compare("inc_h5", "different"),
      compare("inc_x", "same", "different"),
      compare("inc_y", "same"),
      { ok: true, tool: "propose_decision" },
    ];
    expect(agentCheckOf(steps, "inc_h1")).toEqual({ checks: 5, matching: 1, ruledOut: 2, against: 1 });
  });

  it("refuses to approve a suggestion that names no incident", async () => {
    fastSays("NEW", null);
    await runStep(rt, "duplicate", 0);
    await expect(runStep(rt, "duplicate", 3)).rejects.toThrow(/names no incident/);
  });

  it("seeds the real San Francisco pairs at their own place and time, and sends their later photos as real", async () => {
    const real = await rt.database.select().from(incidents).where(inArray(incidents.id, REAL_PAIRS.map((p) => seedIncidentId(p.id))));
    expect(real).toHaveLength(REAL_PAIRS.length);
    const alemany = real.find((i) => i.id === "inc_sf123")!;
    expect(alemany.status).toBe("resolved");
    expect(Date.parse(alemany.resolved_at!)).toBe(Date.parse("2026-09-09T15:45:44.000Z"));
    fastSays("DUPLICATE", "inc_sf058");
    const sent = (await runStep(rt, "sf311", 0)) as Sent;
    expect(sent.label).toBe("DUPLICATE");
    const [report] = await rt.database.select().from(reports).where(eq(reports.id, sent.report_id));
    expect(report).toMatchObject({ is_synthetic: false, lat: 37.751603, lng: -122.428049 });
    expect(Date.parse(report!.observed_at)).toBe(Date.parse("2026-09-15T16:24:14.000Z"));
    const [photo] = await rt.database.select().from(images).where(eq(images.report_id, sent.report_id));
    expect(photo).toMatchObject({ mime: "image/jpeg", is_synthetic: false, dataset_image_id: "sf_t058_2", width: 864, height: 1152 });
    // The cleanup is part of the seeded world, so the step after it is not asked to reset.
    fastSays("NEW", null);
    expect(((await runStep(rt, "sf311", 1)) as Sent).label).toBe("NEW");
  });

  it("keeps a photo seen before the repair before it, however long after the reset it is sent", async () => {
    await runStep(rt, "after-repair", 0);
    fastSays("LATE_REPORT", seedIncidentId("H2"));
    const fourDaysOn = vi.spyOn(Date, "now").mockReturnValue(Date.now() + 96 * 3_600_000);
    try {
      const sent = (await runStep(rt, "after-repair", 1)) as Sent;
      const [report] = await rt.database.select({ observed_at: reports.observed_at }).from(reports).where(eq(reports.id, sent.report_id));
      const [incident] = await rt.database.select({ resolved_at: incidents.resolved_at }).from(incidents).where(eq(incidents.id, seedIncidentId("H2")));
      expect(Date.parse(incident!.resolved_at!) - Date.parse(report!.observed_at)).toBe(24 * 3_600_000);
    } finally {
      fourDaysOn.mockRestore();
    }
  });

  it("asks for a reset when the world a step expects has moved on", async () => {
    await runStep(rt, "after-repair", 0);
    await expect(runStep(rt, "after-repair", 0)).rejects.toThrow(/Reset it to the start/);
  });
});
