// Author: HyeonMo Gu
// Created: 2026-10-27

import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { and, eq } from "drizzle-orm";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { fileBlobs } from "../db/blobs";
import { openPglite } from "../db/client";
import { agentRuns, images, incidents, infoRequests, reportAnalyses, reports, staffDecisions } from "../db/schema";
import { ASSET_FILE } from "../dataset/static";
import { messageSample } from "../dataset/messages";
import { seedDemo, uploadVoices } from "../demo/seed";
import { CacheMissError } from "../meta/call";
import { analyze, type Analysis, type ReportInput } from "../pipeline/analyze";
import type { Decision } from "../pipeline/decide";
import { verifySuggestion, type Verification } from "../pipeline/hybrid";
import { readIntake, type IntakeResult } from "../pipeline/intake";
import { transcribe } from "../meta/voice";
import { analyzeReport, answerReport, changedFacts, createReport, reanalyzeReport, recordRepair, staffDecide, UserError, verifyReport, WORDS_NOT_READ, wordsNotRead } from "./reports";
import { spendGate, type Runtime } from "./runtime";
import { spend } from "../db/schema";

vi.mock("../pipeline/analyze", async (original) => ({ ...(await original<typeof import("../pipeline/analyze")>()), analyze: vi.fn() }));
vi.mock("../pipeline/hybrid", async (original) => ({ ...(await original<typeof import("../pipeline/hybrid")>()), verifySuggestion: vi.fn() }));
vi.mock("../pipeline/intake", async (original) => ({ ...(await original<typeof import("../pipeline/intake")>()), readIntake: vi.fn() }));
vi.mock("../meta/voice", async (original) => ({ ...(await original<typeof import("../meta/voice")>()), transcribe: vi.fn() }));

const SAMPLE = "syn_H1_damaged_v1_across";
let rt: Runtime;

beforeAll(async () => {
  rt = { database: await openPglite(null), store: fileBlobs(await mkdtemp(path.join(tmpdir(), "civifold-"))) };
  await uploadVoices(rt.store);
}, 60_000);

beforeEach(async () => {
  await seedDemo(rt.database, ASSET_FILE);
  vi.mocked(analyze).mockReset();
  vi.mocked(verifySuggestion).mockReset();
  vi.mocked(readIntake).mockReset();
  vi.mocked(transcribe).mockReset();
}, 30_000);

type Suggestion = Pick<Decision, "label" | "incident_id" | "rule_id" | "missing_info">;

// The fast path's analysis of the report photo, with this decision.
function fastSays(decision: Suggestion, extra: Partial<Analysis> = {}) {
  vi.mocked(analyze).mockResolvedValue({
    pipeline_config: "C_rules",
    prompt_hash: { triage: "t", compare: "c" },
    triage: { out_of_scope: false, category: "fire_hydrant", sam_prompt: "fire hydrant", damage_present: true, damage_description: "cap missing", repair_signs: false, context_landmarks: [], image_quality: "ok", severity: "medium" },
    segmentation: null,
    candidates: [],
    comparisons: [],
    after_fix: null,
    errors: [],
    decision: { ...decision, reasons: [], confidence: 0.9 },
    cost_usd: 0.04,
    latency_ms: 100,
    ...extra,
  } as Analysis);
}

const newReport = (extra: Partial<Parameters<typeof createReport>[1]> = {}) =>
  createReport(rt, {
    photo: { sample_id: SAMPLE },
    voice: null,
    lat: 37.5665,
    lng: 126.978,
    observed_at: new Date().toISOString(),
    observed_at_source: "user",
    description: null,
    category_hint: "fire_hydrant",
    access_code: null,
    ...extra,
  });

describe("reports", () => {
  it("submits a sample photo without uploading anything", async () => {
    const { report_id, tracking_code } = await newReport();
    expect(tracking_code).toMatch(/^CF-[A-Z2-9]{5}-[A-Z2-9]{5}$/);
    const [img] = await rt.database.select().from(images).where(eq(images.report_id, report_id));
    expect(img).toMatchObject({ storage_path: `${SAMPLE}.webp`, dataset_image_id: SAMPLE, is_synthetic: true });
  });

  it("refuses an uploaded photo without the access code", async () => {
    await expect(newReport({ photo: { bytes: Buffer.from("x"), mime: "image/png", width: 1, height: 1 } })).rejects.toBeInstanceOf(UserError);
  });

  it("stores a suggestion for staff without linking anything", async () => {
    const { report_id } = await newReport();
    fastSays({ label: "DUPLICATE", incident_id: "inc_h1", rule_id: "R6a", missing_info: [] });
    expect(await analyzeReport(rt, report_id)).toEqual({ status: "under_review" });
    const [r] = await rt.database.select().from(reports).where(eq(reports.id, report_id));
    expect(r).toMatchObject({ status: "under_review", incident_id: null });
  });

  it("asks the resident, then re-analyzes with the answer photo next to the first", async () => {
    const { report_id } = await newReport();
    fastSays({ label: "NEEDS_INFO", incident_id: null, rule_id: "R6d", missing_info: ["close_up"] });
    expect((await analyzeReport(rt, report_id)).status).toBe("needs_info");
    const [q] = await rt.database.select().from(infoRequests).where(eq(infoRequests.report_id, report_id));
    expect(q).toMatchObject({ source: "template", status: "pending", requested_items: ["close_up"] });
    expect(q!.question).toMatch(/close-up photo of the hydrant/);

    await answerReport(rt, report_id, { photo: { sample_id: "syn_H1_damaged_v1_closeup" } });
    fastSays({ label: "DUPLICATE", incident_id: "inc_h1", rule_id: "R6a", missing_info: [] });
    await analyzeReport(rt, report_id);
    const input = vi.mocked(analyze).mock.calls.at(-1)![0] as ReportInput;
    expect(input.answer_image_ids).toHaveLength(1);
    expect(input.already_asked).toBe(true);
    expect(input.asked_by).toBe("R6d");
  });

  it("reads a photo staff asked for as the close-up they asked for", async () => {
    const { report_id } = await newReport();
    fastSays({ label: "DUPLICATE", incident_id: "inc_h1", rule_id: "R6a", missing_info: [] });
    await analyzeReport(rt, report_id);
    const [a] = await rt.database.select({ id: reportAnalyses.id }).from(reportAnalyses).where(eq(reportAnalyses.report_id, report_id));
    await staffDecide(rt, report_id, "request_info", null, "close_up", { analysis_id: a!.id, facts_changed_seen: false });
    const [q] = await rt.database.select().from(infoRequests).where(eq(infoRequests.report_id, report_id));
    expect(q).toMatchObject({ source: "staff", status: "pending", requested_items: ["close_up"] });

    await answerReport(rt, report_id, { photo: { sample_id: "syn_H1_damaged_v1_closeup" } });
    await analyzeReport(rt, report_id);
    const input = vi.mocked(analyze).mock.calls.at(-1)![0] as ReportInput;
    expect(input).toMatchObject({ already_asked: true, asked_by: "staff:close_up" });
    expect(input.answer_image_ids).toHaveLength(1);
  });

  it("runs the fast path alone and keeps the input it read, for a later verification", async () => {
    const { report_id } = await newReport();
    fastSays({ label: "DUPLICATE", incident_id: "inc_h1", rule_id: "R6a", missing_info: [] });
    await analyzeReport(rt, report_id);
    const [a] = await rt.database.select().from(reportAnalyses).where(eq(reportAnalyses.report_id, report_id));
    expect(a).toMatchObject({ pipeline_config: "C_rules", final: { label: "DUPLICATE", rule_id: "R6a" } });
    expect((a!.input as ReportInput).report_id).toBe(report_id);
    expect(await rt.database.select().from(agentRuns).where(eq(agentRuns.report_id, report_id))).toHaveLength(0);
    expect(verifySuggestion).not.toHaveBeenCalled();
  });

  it("marks a report it cannot replay as unavailable", async () => {
    const { report_id } = await newReport();
    vi.mocked(analyze).mockRejectedValue(new CacheMissError("no cache"));
    expect((await analyzeReport(rt, report_id)).status).toBe("unavailable");
  });

  it("analyzes the photo alone when the words have no recorded reading, and says so", async () => {
    const { report_id } = await newReport({ description: "Water everywhere" });
    vi.mocked(readIntake).mockRejectedValue(new CacheMissError("no cache"));
    fastSays({ label: "DUPLICATE", incident_id: "inc_h1", rule_id: "R6a", missing_info: [] });
    expect(await analyzeReport(rt, report_id)).toEqual({ status: "under_review" });
    const [a] = await rt.database.select().from(reportAnalyses).where(eq(reportAnalyses.report_id, report_id));
    expect(a).toMatchObject({ intake: null, final: { label: "DUPLICATE" }, errors: [WORDS_NOT_READ.no_recording] });
    expect(wordsNotRead(a!.errors)).toBe("no_recording");
    expect(readIntake).toHaveBeenCalledTimes(1);
    expect(analyze).toHaveBeenCalledTimes(1);
    expect((vi.mocked(analyze).mock.calls[0]![0] as ReportInput).description).toBeNull();
  });

  it("stays unavailable when the photo itself has no recorded reading", async () => {
    const { report_id } = await newReport({ description: "Water everywhere" });
    vi.mocked(readIntake).mockRejectedValue(new CacheMissError("no cache"));
    vi.mocked(analyze).mockRejectedValue(new CacheMissError("no cache"));
    expect((await analyzeReport(rt, report_id)).status).toBe("unavailable");
  });

  it("links on staff approval and records agreement", async () => {
    const { report_id } = await newReport();
    fastSays({ label: "DUPLICATE", incident_id: "inc_h1", rule_id: "R6a", missing_info: [] });
    await analyzeReport(rt, report_id);
    await staffDecide(rt, report_id, "link", "inc_h1");
    const [r] = await rt.database.select().from(reports).where(eq(reports.id, report_id));
    expect(r).toMatchObject({ status: "linked", incident_id: "inc_h1" });
    const [d] = await rt.database.select().from(staffDecisions).where(eq(staffDecisions.report_id, report_id));
    expect(d).toMatchObject({ suggested: "DUPLICATE", final_action: "link", agreed: true });
  });

  it("opens a recurrence chain after a recorded repair", async () => {
    await recordRepair(rt, "inc_h1");
    const [h1] = await rt.database.select().from(incidents).where(eq(incidents.id, "inc_h1"));
    expect(h1).toMatchObject({ status: "resolved" });
    expect(h1!.resolved_at).not.toBeNull();

    const { report_id } = await newReport();
    fastSays({ label: "POSSIBLE_RECURRENCE", incident_id: "inc_h1", rule_id: "R7d", missing_info: [] });
    await analyzeReport(rt, report_id);
    await staffDecide(rt, report_id, "recurrence", "inc_h1");
    const [r] = await rt.database.select().from(reports).where(eq(reports.id, report_id));
    const [created] = await rt.database.select().from(incidents).where(eq(incidents.id, r!.incident_id!));
    expect(created).toMatchObject({ recurrence_of: "inc_h1", status: "open" });
  });

  describe("staff-requested verification", () => {
    const DUP: Suggestion = { label: "DUPLICATE", incident_id: "inc_h1", rule_id: "R6a", missing_info: [] };
    const run = (status: "proposed" | "failed" | "budget_exceeded" = "proposed") => ({
      trigger: { label: "DUPLICATE" as const, rule_id: "R6a" },
      status,
      steps: [],
      proposal: null,
      guard: null,
      question: null,
      final: { label: "HUMAN_REVIEW" as const, incident_id: null, missing_info: [] },
      error: status === "proposed" ? null : "stopped",
      cost_usd: 0.05,
      latency_ms: 20,
    });
    const found = (decision: Suggestion, status?: "proposed" | "failed" | "budget_exceeded"): Verification => ({ started: true, agent: run(status), decision });
    const analyses = (id: string) => rt.database.select().from(reportAnalyses).where(eq(reportAnalyses.report_id, id)).orderBy(reportAnalyses.id);
    const runsOf = (id: string) => rt.database.select().from(agentRuns).where(eq(agentRuns.report_id, id));
    const reportRow = async (id: string) => (await rt.database.select().from(reports).where(eq(reports.id, id)))[0]!;
    async function suggested(decision: Suggestion = DUP) {
      const { report_id } = await newReport();
      fastSays(decision);
      await analyzeReport(rt, report_id);
      return { report_id, analysisId: (await analyses(report_id)).at(-1)!.id };
    }
    function held() {
      let release!: (v: Verification) => void;
      vi.mocked(verifySuggestion).mockImplementation(() => new Promise((resolve) => (release = resolve)));
      return (v: Verification) => release(v);
    }

    it("applies what the agent found as a new analysis, from the stored input", async () => {
      const { report_id, analysisId } = await suggested();
      vi.mocked(verifySuggestion).mockResolvedValue(found({ label: "HUMAN_REVIEW", incident_id: null, rule_id: "R2v", missing_info: [] }));
      expect(await verifyReport(rt, report_id, analysisId)).toEqual({ status: "applied", run_status: "proposed", label: "HUMAN_REVIEW", changed: true });
      const [input, analysis] = vi.mocked(verifySuggestion).mock.calls[0]!;
      expect(input.report_id).toBe(report_id);
      expect(analysis.decision).toMatchObject({ label: "DUPLICATE", rule_id: "R6a" });
      const rows = await analyses(report_id);
      expect(rows).toHaveLength(2);
      expect(rows[1]).toMatchObject({ pipeline_config: "C_rules+verify", decision: { label: "DUPLICATE" }, final: { label: "HUMAN_REVIEW", rule_id: "R2v" } });
      expect(await runsOf(report_id)).toMatchObject([{ requested_by: "staff", applied: true, analysis_id: analysisId, status: "proposed" }]);
      expect(await reportRow(report_id)).toMatchObject({ status: "under_review", verify_claimed_at: null });
    });

    it("leaves the suggestion unchanged when the agent cannot start, and can be asked again", async () => {
      const { report_id, analysisId } = await suggested();
      vi.mocked(verifySuggestion).mockResolvedValue({ started: false, reason: "no_recording", message: "no cache" });
      expect(await verifyReport(rt, report_id, analysisId)).toMatchObject({ status: "not_started", reason: "no_recording" });
      expect(await analyses(report_id)).toHaveLength(1);
      expect(await runsOf(report_id)).toHaveLength(0);
      expect((await reportRow(report_id)).verify_claimed_at).toBeNull();
      vi.mocked(verifySuggestion).mockResolvedValue(found(DUP));
      expect(await verifyReport(rt, report_id, analysisId)).toMatchObject({ status: "applied", changed: false });
    });

    it("applies the evidence of a run that stopped partway", async () => {
      const { report_id, analysisId } = await suggested();
      vi.mocked(verifySuggestion).mockResolvedValue(found({ label: "NEEDS_INFO", incident_id: null, rule_id: "R2v", missing_info: ["different_angle"] }, "budget_exceeded"));
      expect(await verifyReport(rt, report_id, analysisId)).toMatchObject({ status: "applied", run_status: "budget_exceeded", label: "NEEDS_INFO" });
      expect(await reportRow(report_id)).toMatchObject({ status: "needs_info" });
      const [q] = await rt.database.select().from(infoRequests).where(eq(infoRequests.report_id, report_id));
      expect(q).toMatchObject({ status: "pending", requested_items: ["different_angle"], reason_for_staff: "R2v" });
      expect(await runsOf(report_id)).toMatchObject([{ status: "budget_exceeded", applied: true }]);
    });

    it("runs one verification at a time", async () => {
      const { report_id, analysisId } = await suggested();
      const finish = held();
      const first = verifyReport(rt, report_id, analysisId);
      await vi.waitFor(() => expect(verifySuggestion).toHaveBeenCalledTimes(1));
      await expect(verifyReport(rt, report_id, analysisId)).rejects.toThrow(/already running/);
      finish(found(DUP));
      expect(await first).toMatchObject({ status: "applied" });
      expect(await runsOf(report_id)).toHaveLength(1);
    });

    it("refuses to verify an analysis that is no longer the latest, and frees the report", async () => {
      const { report_id, analysisId } = await suggested();
      await expect(verifyReport(rt, report_id, analysisId + 1000)).rejects.toThrow(/analyzed again/);
      expect(verifySuggestion).not.toHaveBeenCalled();
      expect((await reportRow(report_id)).verify_claimed_at).toBeNull();
    });

    it("records but does not apply a result that arrives after staff decided", async () => {
      const { report_id, analysisId } = await suggested();
      const finish = held();
      const pending = verifyReport(rt, report_id, analysisId);
      await vi.waitFor(() => expect(verifySuggestion).toHaveBeenCalledTimes(1));
      await staffDecide(rt, report_id, "dismiss", null);
      finish(found({ label: "HUMAN_REVIEW", incident_id: null, rule_id: "R2v", missing_info: [] }));
      expect(await pending).toEqual({ status: "superseded", run_status: "proposed" });
      expect(await analyses(report_id)).toHaveLength(1);
      expect(await runsOf(report_id)).toMatchObject([{ applied: false, requested_by: "staff" }]);
      expect(await reportRow(report_id)).toMatchObject({ status: "dismissed", verify_claimed_at: null });
    });

    it("streams each finished tool call to the caller", async () => {
      const { report_id, analysisId } = await suggested();
      vi.mocked(verifySuggestion).mockResolvedValue(found(DUP));
      const onStep = vi.fn();
      await verifyReport(rt, report_id, analysisId, onStep);
      expect(vi.mocked(verifySuggestion).mock.calls[0]![3]).toBe(onStep);
    });

    it("refuses a staff choice made on a suggestion that verification replaced since", async () => {
      const { report_id, analysisId } = await suggested();
      vi.mocked(verifySuggestion).mockResolvedValue(found({ label: "HUMAN_REVIEW", incident_id: null, rule_id: "R2v", missing_info: [] }));
      await verifyReport(rt, report_id, analysisId);
      const stale = staffDecide(rt, report_id, "link", "inc_h1", "wider_context", { analysis_id: analysisId, facts_changed_seen: false });
      await expect(stale).rejects.toMatchObject({ code: "stale" });
      expect(await reportRow(report_id)).toMatchObject({ status: "under_review", incident_id: null });
      // Having seen the latest, staff may still choose differently from it.
      await staffDecide(rt, report_id, "link", "inc_h1", "wider_context", { analysis_id: (await analyses(report_id)).at(-1)!.id, facts_changed_seen: false });
      expect(await reportRow(report_id)).toMatchObject({ status: "linked", incident_id: "inc_h1" });
    });

    describe("an incident that changed since the suggestion", () => {
      const H1 = { incident_id: "inc_h1", status: "open" as const, created_at: "2026-10-01T00:00:00.000Z", resolved_at: null, recurrence_of: null, distance_m: 4 };
      async function suggestedBeforeRepair() {
        const { report_id } = await newReport();
        fastSays(DUP, { candidates: [H1] });
        await analyzeReport(rt, report_id);
        await recordRepair(rt, "inc_h1");
        return { report_id, analysisId: (await analyses(report_id)).at(-1)!.id };
      }

      it("reads the rules' view of a change: open or in progress alike, the repair time to the instant", () => {
        const at = "2026-10-27T15:00:00.000Z";
        expect(changedFacts([H1], [{ id: "inc_h1", status: "in_progress", resolved_at: null }])).toEqual([]);
        expect(changedFacts([{ ...H1, status: "resolved", resolved_at: at }], [{ id: "inc_h1", status: "resolved", resolved_at: "2026-10-27 15:00:00+00" }])).toEqual([]);
        expect(changedFacts([H1], [{ id: "inc_h1", status: "resolved", resolved_at: at }])).toEqual([
          { incident_id: "inc_h1", was: { status: "open", resolved_at: null }, now: { status: "resolved", resolved_at: at } },
        ]);
      });

      it("does not verify it, and frees the report", async () => {
        const { report_id, analysisId } = await suggestedBeforeRepair();
        expect(await verifyReport(rt, report_id, analysisId)).toMatchObject({ status: "facts_changed", changes: [{ incident_id: "inc_h1", now: { status: "resolved" } }] });
        expect(verifySuggestion).not.toHaveBeenCalled();
        expect(await runsOf(report_id)).toHaveLength(0);
        expect((await reportRow(report_id)).verify_claimed_at).toBeNull();
      });

      it("analyzes it again on staff request, replacing the suggestion", async () => {
        const { report_id, analysisId } = await suggestedBeforeRepair();
        fastSays({ label: "LATE_REPORT", incident_id: "inc_h1", rule_id: "R7l", missing_info: [] });
        expect(await reanalyzeReport(rt, report_id, analysisId)).toEqual({ status: "analyzed", label: "LATE_REPORT" });
        expect(await analyses(report_id)).toHaveLength(2);
        expect(await reportRow(report_id)).toMatchObject({ status: "under_review" });
        await expect(reanalyzeReport(rt, report_id, analysisId)).rejects.toThrow(/analyzed again/);
      });

      it("refuses a staff choice whose screen did not show the change, and takes one whose screen did", async () => {
        const { report_id, analysisId } = await suggestedBeforeRepair();
        await expect(staffDecide(rt, report_id, "link", "inc_h1", "wider_context", { analysis_id: analysisId, facts_changed_seen: false })).rejects.toMatchObject({ code: "stale" });
        await staffDecide(rt, report_id, "link", "inc_h1", "wider_context", { analysis_id: analysisId, facts_changed_seen: true });
        expect(await reportRow(report_id)).toMatchObject({ status: "linked" });
      });

      it("keeps the current suggestion when the new analysis cannot run", async () => {
        const { report_id, analysisId } = await suggestedBeforeRepair();
        vi.mocked(analyze).mockRejectedValue(new CacheMissError("k"));
        expect(await reanalyzeReport(rt, report_id, analysisId)).toMatchObject({ status: "not_started" });
        expect(await analyses(report_id)).toHaveLength(1);
        expect(await reportRow(report_id)).toMatchObject({ status: "under_review" });
      });
    });

    it("verifies only a closing suggestion, at most twice per report", async () => {
      const fresh = await suggested({ label: "NEW", incident_id: null, rule_id: "R1", missing_info: [] });
      await expect(verifyReport(rt, fresh.report_id, fresh.analysisId)).rejects.toThrow(/Only a duplicate/);

      const { report_id, analysisId } = await suggested();
      vi.mocked(verifySuggestion).mockResolvedValue(found(DUP));
      await verifyReport(rt, report_id, analysisId);
      await verifyReport(rt, report_id, (await analyses(report_id)).at(-1)!.id);
      await expect(verifyReport(rt, report_id, (await analyses(report_id)).at(-1)!.id)).rejects.toThrow(/most allowed/);
    });
  });

  describe("messages without a photo", () => {
    const H1 = messageSample("msg_H1_voice_en")!;
    const reads = (over: Partial<IntakeResult> = {}) =>
      vi.mocked(readIntake).mockResolvedValue({
        result: { emergency: false, emergency_reason: null, out_of_scope: false, category: "fire_hydrant", problem: "Hydrant leaking.", place: "by the bakery", landmarks: ["BAKERY"], observed_time: null, ...over },
        call: { model: "m", key: "k", cached: true, usd: 0, ms: 0 },
        prompt_hash: "h",
      });
    const message = (extra: Partial<Parameters<typeof createReport>[1]>) =>
      newReport({ photo: null, lat: H1.lat, lng: H1.lng, category_hint: null, ...extra });

    it("refuses a report with nothing in it, and a visitor's own recording without the code", async () => {
      await expect(message({})).rejects.toBeInstanceOf(UserError);
      await expect(message({ voice: { bytes: Buffer.from("x") } })).rejects.toBeInstanceOf(UserError);
    });

    it("asks for a photo when an incident of the same kind is nearby, and matches nothing", async () => {
      const { report_id } = await message({ description: "The hydrant by the bakery is leaking." });
      reads();
      expect(await analyzeReport(rt, report_id)).toEqual({ status: "needs_info" });
      expect(analyze).not.toHaveBeenCalled();
      const [r] = await rt.database.select().from(reports).where(eq(reports.id, report_id));
      expect(r).toMatchObject({ channel: "text", incident_id: null, urgent: false, is_synthetic: false });
      const [q] = await rt.database.select().from(infoRequests).where(eq(infoRequests.report_id, report_id));
      expect(q).toMatchObject({ requested_items: ["photo"], reason_for_staff: "R0p" });
      expect(q!.question).toMatch(/add a photo of the hydrant/);
    });

    it("sends the answer photo through the photo pipeline with the message as the note", async () => {
      const { report_id } = await message({ description: "The hydrant by the bakery is leaking." });
      reads();
      await analyzeReport(rt, report_id);
      await answerReport(rt, report_id, { photo: { sample_id: SAMPLE } });
      fastSays({ label: "DUPLICATE", incident_id: "inc_h1", rule_id: "R6a", missing_info: [] });
      await analyzeReport(rt, report_id);
      const input = vi.mocked(analyze).mock.calls.at(-1)![0] as ReportInput;
      expect(input).toMatchObject({ description: "The hydrant by the bakery is leaking.", already_asked: true, answer_image_ids: [] });
    });

    it("transcribes a sample recording once and flags an emergency for staff", async () => {
      const { report_id } = await message({ voice: { sample_id: "msg_S1_voice_smoke" } });
      vi.mocked(transcribe).mockResolvedValue({ transcript: "Smoke from the street light.", duration_ms: 5000, call: { model: "v", key: "k", cached: true, usd: 0, ms: 0 } });
      reads({ emergency: true, emergency_reason: "Smoke from a street light.", category: "streetlight" });
      expect(await analyzeReport(rt, report_id)).toEqual({ status: "under_review" });
      const [r] = await rt.database.select().from(reports).where(eq(reports.id, report_id));
      expect(r).toMatchObject({ channel: "voice", transcript: "Smoke from the street light.", urgent: true, is_synthetic: true });
      expect(vi.mocked(readIntake).mock.calls[0]![0]).toBe("Smoke from the street light.");

      // A retry after a failure reuses the stored transcript.
      await rt.database.update(reports).set({ status: "failed" }).where(eq(reports.id, report_id));
      await analyzeReport(rt, report_id);
      expect(transcribe).toHaveBeenCalledTimes(1);
    });
  });

  describe("state and races", () => {
    it("runs one analysis at a time and never re-analyzes a decided report", async () => {
      const { report_id } = await newReport();
      fastSays({ label: "DUPLICATE", incident_id: "inc_h1", rule_id: "R6a", missing_info: [] });
      const both = await Promise.allSettled([analyzeReport(rt, report_id), analyzeReport(rt, report_id)]);
      expect(both.filter((r) => r.status === "fulfilled")).toHaveLength(1);
      expect(analyze).toHaveBeenCalledTimes(1);
      await staffDecide(rt, report_id, "link", "inc_h1");
      await expect(analyzeReport(rt, report_id)).rejects.toThrow(/linked/);
    });

    it("leaves a failed analysis to staff with the error, and lets it be retried", async () => {
      const { report_id } = await newReport();
      vi.mocked(analyze).mockRejectedValue(new Error("HTTP 500 after retries"));
      expect((await analyzeReport(rt, report_id)).status).toBe("failed");
      const [r] = await rt.database.select().from(reports).where(eq(reports.id, report_id));
      expect(r).toMatchObject({ status: "failed", error: "HTTP 500 after retries" });
      fastSays({ label: "NEW", incident_id: null, rule_id: "R1", missing_info: [] });
      expect((await analyzeReport(rt, report_id)).status).toBe("under_review");
    });

    it("opens one incident however often staff click, and checks the target", async () => {
      const { report_id } = await newReport();
      fastSays({ label: "NEW", incident_id: null, rule_id: "R1", missing_info: [] });
      await analyzeReport(rt, report_id);
      const clicks = await Promise.allSettled([staffDecide(rt, report_id, "new_incident", null), staffDecide(rt, report_id, "new_incident", null)]);
      expect(clicks.filter((c) => c.status === "fulfilled")).toHaveLength(1);
      expect((await rt.database.select().from(incidents)).length).toBe(17);

      const other = (await newReport()).report_id;
      fastSays({ label: "NEW", incident_id: null, rule_id: "R1", missing_info: [] });
      await analyzeReport(rt, other);
      await expect(staffDecide(rt, other, "link", "inc_nope")).rejects.toThrow(/Unknown incident/);
      await expect(staffDecide(rt, other, "recurrence", "inc_h1")).rejects.toThrow(/still open/);
    });

    it("records a repair once; a second click does not move the repair time", async () => {
      await recordRepair(rt, "inc_h1", "2026-10-20T00:00:00.000Z");
      await expect(recordRepair(rt, "inc_h1")).rejects.toBeInstanceOf(UserError);
      const [h1] = await rt.database.select().from(incidents).where(eq(incidents.id, "inc_h1"));
      expect(new Date(h1!.resolved_at!).toISOString()).toBe("2026-10-20T00:00:00.000Z");
    });

    it("takes one answer per question, and an uploaded answer needs the access code", async () => {
      const { report_id } = await newReport();
      fastSays({ label: "NEEDS_INFO", incident_id: null, rule_id: "R6d", missing_info: ["close_up"] });
      await analyzeReport(rt, report_id);
      await expect(answerReport(rt, report_id, { photo: { bytes: Buffer.from("x"), mime: "image/png", width: 1, height: 1 } })).rejects.toThrow(/access code/);
      await answerReport(rt, report_id, { photo: { sample_id: "syn_H1_damaged_v1_closeup" } });
      await expect(answerReport(rt, report_id, { photo: { sample_id: "syn_H1_damaged_v1_front" } })).rejects.toBeInstanceOf(UserError);
    });

    it("reads the answer photo first when the first photo was unusable (as the evaluation does)", async () => {
      const { report_id } = await newReport();
      fastSays({ label: "NEEDS_INFO", incident_id: null, rule_id: "R0", missing_info: ["close_up"] });
      await analyzeReport(rt, report_id);
      await answerReport(rt, report_id, { photo: { sample_id: "syn_H1_damaged_v1_closeup" } });
      fastSays({ label: "DUPLICATE", incident_id: "inc_h1", rule_id: "R6a", missing_info: [] });
      await analyzeReport(rt, report_id);
      const input = vi.mocked(analyze).mock.calls.at(-1)![0] as ReportInput;
      const [answer] = await rt.database.select().from(images).where(and(eq(images.report_id, report_id), eq(images.dataset_image_id, "syn_H1_damaged_v1_closeup")));
      expect(input).toMatchObject({ image_id: answer!.id, answer_image_ids: [], asked_by: "R0" });
    });

    it("lets only as many concurrent live calls through as the daily budget holds", async () => {
      const gate = spendGate(rt.database, 1);
      const held = await Promise.all(Array.from({ length: 5 }, () => gate.reserve(0.3)));
      expect(held.filter(Boolean)).toHaveLength(3);
      await gate.settle(held.find((h) => h !== null)!, 0.1);
      const [row] = await rt.database.select().from(spend);
      expect(row!.usd).toBeCloseTo(0.7);
    });
  });

  describe("lifecycle and danger", () => {
    it("never leaves a report analyzing when storing the result fails", async () => {
      const { report_id } = await newReport();
      fastSays({ label: "HUMAN_REVIEW", incident_id: null, rule_id: "R5", missing_info: [] }, { comparisons: [{ unserializable: 1n }] as never });
      expect((await analyzeReport(rt, report_id)).status).toBe("failed");
      const [r] = await rt.database.select().from(reports).where(eq(reports.id, report_id));
      expect(r!.status).toBe("failed");
      expect(await rt.database.select().from(reportAnalyses).where(eq(reportAnalyses.report_id, report_id))).toHaveLength(0);
    });

    it("puts a report ticked as dangerous in the urgent queue at once and routes it without models", async () => {
      const { report_id } = await newReport({ photo: null, voice: { sample_id: "msg_S1_voice_smoke" }, danger: true });
      const [created] = await rt.database.select().from(reports).where(eq(reports.id, report_id));
      expect(created).toMatchObject({ urgent: true, danger: true });
      vi.mocked(transcribe).mockRejectedValue(new CacheMissError("no cache"));
      expect(await analyzeReport(rt, report_id)).toEqual({ status: "under_review" });
      const [a] = await rt.database.select().from(reportAnalyses).where(eq(reportAnalyses.report_id, report_id));
      expect(a!.final).toMatchObject({ label: "HUMAN_REVIEW", rule_id: "R0e", urgent: true });
      expect(readIntake).not.toHaveBeenCalled();
    });

    it("routes a dangerous typed report even when its words cannot be read", async () => {
      const { report_id } = await newReport({ description: "smoke!", danger: true });
      vi.mocked(readIntake).mockRejectedValue(new CacheMissError("no cache"));
      expect(await analyzeReport(rt, report_id)).toEqual({ status: "under_review" });
      expect(analyze).not.toHaveBeenCalled();
    });
  });

  it("keeps only the winning answer's photo when two answers arrive at once, and none after staff decided", async () => {
    const { report_id } = await newReport();
    fastSays({ label: "NEEDS_INFO", incident_id: null, rule_id: "R6d", missing_info: ["close_up"] });
    await analyzeReport(rt, report_id);
    const both = await Promise.allSettled([
      answerReport(rt, report_id, { photo: { sample_id: "syn_H1_damaged_v1_closeup" } }),
      answerReport(rt, report_id, { photo: { sample_id: "syn_H1_damaged_v1_sidewalk" } }),
    ]);
    expect(both.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect(await rt.database.select().from(images).where(eq(images.report_id, report_id))).toHaveLength(2);

    const other = (await newReport()).report_id;
    await analyzeReport(rt, other);
    await staffDecide(rt, other, "dismiss", null);
    await expect(answerReport(rt, other, { photo: { sample_id: "syn_H1_damaged_v1_closeup" } })).rejects.toBeInstanceOf(UserError);
    expect(await rt.database.select().from(images).where(eq(images.report_id, other))).toHaveLength(1);
  });

  describe("analysis lease", () => {
    const claim = (report_id: string, minutesAgo: number) =>
      rt.database.update(reports).set({ status: "analyzing", claimed_at: new Date(Date.now() - minutesAgo * 60_000).toISOString() }).where(eq(reports.id, report_id));

    it("refuses a running analysis but takes over one whose claim went stale", async () => {
      const { report_id } = await newReport();
      fastSays({ label: "NEW", incident_id: null, rule_id: "R1", missing_info: [] });
      await claim(report_id, 1);
      await expect(analyzeReport(rt, report_id)).rejects.toThrow(/analyzing/);
      await claim(report_id, 20);
      expect(await analyzeReport(rt, report_id)).toEqual({ status: "under_review" });
    });

    it("lets staff decide a stale analysis and drops that analysis's late result", async () => {
      const { report_id } = await newReport();
      vi.mocked(analyze).mockImplementation(async () => {
        // While this run is underway its claim goes stale and staff decide the report.
        await claim(report_id, 20);
        await staffDecide(rt, report_id, "dismiss", null);
        throw new Error("never reached");
      });
      expect((await analyzeReport(rt, report_id)).status).toBe("superseded");
      const [r] = await rt.database.select().from(reports).where(eq(reports.id, report_id));
      expect(r!.status).toBe("dismissed");
    });

    it("discards a result whose claim was taken over by a newer analysis", async () => {
      const { report_id } = await newReport();
      fastSays({ label: "DUPLICATE", incident_id: "inc_h1", rule_id: "R6a", missing_info: [] });
      const inner = vi.mocked(analyze).getMockImplementation()!;
      vi.mocked(analyze).mockImplementation(async (...args) => {
        await rt.database.update(reports).set({ claimed_at: new Date().toISOString() }).where(eq(reports.id, report_id));
        return inner(...args);
      });
      expect((await analyzeReport(rt, report_id)).status).toBe("superseded");
      expect(await rt.database.select().from(reportAnalyses).where(eq(reportAnalyses.report_id, report_id))).toHaveLength(0);
    });
  });
});
