// Author: HyeonMo Gu
// Created: 2026-10-27

// Everything the screens do with a report: submit, analyze, answer a question, and the staff actions.
// The system only suggests; a report joins or opens an incident when staff act on it.
import { randomBytes } from "node:crypto";
import { and, asc, count, desc, eq, inArray, isNull, lt, or } from "drizzle-orm";
import { messageSample, voiceBlobKey } from "../dataset/messages";
import { VIEW_SIZE } from "../dataset/assets";
import { sample } from "../dataset/static";
import { agentRuns, briefs, images, incidentEvents, incidents, infoRequests, reportAnalyses, reports, segmentations, staffDecisions } from "../db/schema";
import { blobKey } from "../db/stores";
import { CacheMissError, LiveBudgetError, metered } from "../meta/call";
import { transcribe } from "../meta/voice";
import { channelOf, messageText, type IntakeResult } from "../pipeline/intake";
import type { AgentStep } from "../agent/run";
import { staffAsk, type Analysis, type ReportInput } from "../pipeline/analyze";
import type { Candidate } from "../pipeline/decide";
import { AGENT_LIMITS } from "../pipeline/config";
import { verifySuggestion, VERIFIED } from "../pipeline/hybrid";
import { processReport, type IncomingReport, type ProcessResult } from "../pipeline/process";
import type { Category, Label, RequestItem } from "../tools/types";
import type { PhotoMeta } from "./photo-meta";
import { templateQuestion } from "./questions";
import { accessCodeValid, runMode, toolContext, type Runtime } from "./runtime";

const id = (prefix: string) => `${prefix}_${randomBytes(5).toString("hex")}`;
const CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
// The tracking code is the resident's only key to their report (and, for a live report, to answering it),
// so it must not be guessable: 10 symbols from 32 is 2^50 codes. 256 % 32 = 0, so the symbols are uniform.
const trackingCode = () => {
  const s = Array.from(randomBytes(10), (b) => CODE_ALPHABET[b % CODE_ALPHABET.length]).join("");
  return `CF-${s.slice(0, 5)}-${s.slice(5)}`;
};

// An upload carries what its EXIF said before the photo was normalized (and the EXIF dropped).
export type Photo = { sample_id: string } | { bytes: Buffer; mime: string; width: number; height: number; meta?: PhotoMeta };

// A recording is a sample message's WAV or the visitor's own (16/24 kHz mono 16-bit, checked on upload).
export type Voice = { sample_id: string } | { bytes: Buffer };

export type NewReport = {
  photo: Photo | null;
  voice: Voice | null;
  lat: number;
  lng: number;
  observed_at: string;
  observed_at_source: "user" | "exif" | "assumed_submit_time";
  description: string | null;
  category_hint: Category | null;
  danger?: boolean;
  access_code: string | null;
};

// code "stale": the screen acted on a suggestion that is no longer the latest; it should reload, not retry.
export class UserError extends Error {
  constructor(
    message: string,
    readonly code?: "stale",
  ) {
    super(message);
  }
}

// The images row for a photo. An upload goes to the blob store first; the row is inserted by the caller,
// inside whatever transaction decides whether the photo counts.
async function photoRow(rt: Runtime, reportId: string, photo: Photo): Promise<typeof images.$inferInsert> {
  const imageRowId = id("img");
  if ("sample_id" in photo) {
    const s = sample(photo.sample_id);
    if (!s) throw new UserError(`Unknown sample photo ${photo.sample_id}`);
    // Sample photos are already in the blob store (the seed uploads the dataset); the row points at them.
    return {
      id: imageRowId,
      report_id: reportId,
      kind: "original",
      storage_path: blobKey(s.id, "image/webp"),
      mime: "image/webp",
      // The real size: SAM's box, the crops and the overlay all read it, and close-ups are upright.
      ...VIEW_SIZE[s.view],
      is_synthetic: true,
      dataset_image_id: s.id,
    };
  }
  const key = `uploads/${blobKey(imageRowId, photo.mime)}`;
  await rt.store.put(key, photo.bytes, photo.mime);
  return { id: imageRowId, report_id: reportId, kind: "original", storage_path: key, mime: photo.mime, width: photo.width, height: photo.height, is_synthetic: false };
}

export async function createReport(rt: Runtime, input: NewReport): Promise<{ report_id: string; tracking_code: string }> {
  const { photo, voice } = input;
  const live = accessCodeValid(input.access_code);
  if (!photo && !voice && !input.description) throw new UserError("Add a photo, a message or a recording.");
  if (photo && !("sample_id" in photo) && !live) throw new UserError("Uploading your own photo needs the demo access code. Pick a sample photo instead.");
  if (voice && !("sample_id" in voice) && !live) throw new UserError("Sending your own recording needs the demo access code. Pick a sample message instead.");
  if (voice && "sample_id" in voice && messageSample(voice.sample_id)?.kind !== "voice") throw new UserError(`Unknown sample recording ${voice.sample_id}`);
  const reportId = id("rep");
  const code = trackingCode();
  // Sample recordings are in the blob store already (the seed uploads them); a visitor's own goes next to uploaded photos.
  let audioPath: string | null = null;
  if (voice) {
    audioPath = "sample_id" in voice ? voiceBlobKey(voice.sample_id) : `uploads/audio/${reportId}.wav`;
    if (!("sample_id" in voice)) await rt.store.put(audioPath, voice.bytes, "audio/wav");
  }
  const media = [photo, voice].filter((m) => m !== null);
  await rt.database.insert(reports).values({
    id: reportId,
    tracking_code: code,
    lat: input.lat,
    lng: input.lng,
    observed_at: input.observed_at,
    observed_at_source: input.observed_at_source,
    submitted_at: new Date().toISOString(),
    description: input.description,
    category_hint: input.category_hint,
    channel: channelOf({ photo: photo !== null, text: Boolean(input.description), voice: voice !== null }),
    audio_path: audioPath,
    danger: input.danger ?? false,
    urgent: input.danger ?? false, // in the urgent queue from the start, before any model runs
    status: "received",
    live,
    is_synthetic: media.length > 0 && media.every((m) => "sample_id" in m),
  });
  if (photo) await rt.database.insert(images).values(await photoRow(rt, reportId, photo));
  return { report_id: reportId, tracking_code: code };
}

export type WordsUnread = "no_recording" | "budget";

// Stored with the analysis's errors when a report's words went unread, and said to staff as is.
export const WORDS_NOT_READ: Record<WordsUnread, string> = {
  no_recording: "The resident's words were not read: the public demo has no recorded reading of them. The suggestion comes from the photo alone.",
  budget: "The resident's words were not read: live model calls are paused for today. The suggestion comes from the photo alone.",
};

/** Why an analysis's words went unread, from its stored errors; null when they were read (or there were none). */
export function wordsNotRead(errors: unknown): WordsUnread | null {
  const list = Array.isArray(errors) ? (errors as unknown[]) : [];
  return (Object.keys(WORDS_NOT_READ) as WordsUnread[]).find((why) => list.includes(WORDS_NOT_READ[why])) ?? null;
}

// received: new; answered: the resident replied; unavailable or failed: a retry.
const ANALYZABLE = ["received", "answered", "unavailable", "failed"];

// An analysis whose process died (a killed function, a lost database) leaves its claim behind. After this
// long, well past the 300 s a request may run, the claim is stale: the report can be analyzed or decided again.
export const ANALYSIS_LEASE_MS = 10 * 60_000;

export function staleAnalysis(report: { status: string; claimed_at: string | null }, now = Date.now()): boolean {
  return report.status === "analyzing" && (report.claimed_at === null || Date.parse(report.claimed_at) < now - ANALYSIS_LEASE_MS);
}

/** A staff-requested verification holds the report while its lease is fresh (verifyReport). */
export function verifyRunning(report: { verify_claimed_at: string | null }, now = Date.now()): boolean {
  return report.verify_claimed_at !== null && Date.parse(report.verify_claimed_at) > now - ANALYSIS_LEASE_MS;
}

const staleClaim = () =>
  and(eq(reports.status, "analyzing"), or(isNull(reports.claimed_at), lt(reports.claimed_at, new Date(Date.now() - ANALYSIS_LEASE_MS).toISOString())));

class LeaseLost extends Error {}

// About the costliest live analysis (triage, SAM and several comparisons), so a fallback to live calls can finish.
export const ANALYSIS_USD = 0.1;

/**
 * Transcribes a recording once, reads the resident's words, and runs the photo pipeline (the fast path)
 * unless the words or a missing photo route the report first. Every step is stored for the screens.
 */
export async function analyzeReport(rt: Runtime, reportId: string): Promise<{ status: string; error?: string }> {
  const { database } = rt;
  // Claimed in one conditional update: two requests for the same report cannot both run, and a decided
  // report is never re-analyzed.
  const claimedAt = new Date().toISOString();
  const [report] = await database
    .update(reports)
    .set({ status: "analyzing", claimed_at: claimedAt })
    .where(and(eq(reports.id, reportId), or(inArray(reports.status, ANALYZABLE), staleClaim())))
    .returning();
  if (!report) {
    const [exists] = await database.select({ status: reports.status }).from(reports).where(eq(reports.id, reportId));
    if (!exists) throw new UserError(`Unknown report ${reportId}`);
    throw new UserError(`This report is ${exists.status.replace("_", " ")}; it cannot be analyzed now.`);
  }
  // From the claim on, every way out sets a status: nothing, a database error included, leaves it "analyzing".
  // Writes after the claim apply only while it is still ours: a stale claim may have been taken over.
  const ours = and(eq(reports.id, reportId), eq(reports.status, "analyzing"), eq(reports.claimed_at, claimedAt));
  try {
    return await runAnalysis(rt, report, claimedAt);
  } catch (err) {
    const superseded = { status: "superseded", error: "Another analysis or a staff decision took over this report." };
    if (err instanceof LeaseLost) return superseded;
    if (err instanceof CacheMissError || err instanceof LiveBudgetError) {
      const kept = await database.update(reports).set({ status: "unavailable" }).where(ours).returning({ id: reports.id });
      if (kept.length === 0) return superseded;
      return { status: "unavailable", ...(err instanceof LiveBudgetError ? { error: err.message } : {}) };
    }
    console.error(`analysis of ${reportId} failed`, err);
    const message = (err instanceof Error ? err.message : String(err)).slice(0, 500);
    const kept = await database.update(reports).set({ status: "failed", error: message }).where(ours).returning({ id: reports.id });
    if (kept.length === 0) return superseded;
    return { status: "failed", error: "The automatic check failed. Staff will review your report." };
  }
}

/**
 * The access code turns a report the public demo could not check (no recorded result) into a live one, so the
 * next analysis may call the models. Only a report that is not running or decided can be switched.
 */
export async function goLive(rt: Runtime, reportId: string, code: string | null): Promise<void> {
  if (!accessCodeValid(code)) throw new UserError("That access code is not right.");
  const switched = await rt.database
    .update(reports)
    .set({ live: true })
    .where(and(eq(reports.id, reportId), inArray(reports.status, ["unavailable", "failed"])))
    .returning({ id: reports.id });
  if (switched.length === 0) throw new UserError("This report is not waiting for a live check.");
}

export type ReanalyzeResult = { status: "analyzed"; label: Label } | { status: "not_started"; message: string } | { status: "superseded" };

/**
 * Staff run the fast path again on a suggestion waiting for them, usually because an incident it relied on
 * changed since (changedFacts). The current suggestion stays until a new one is stored: if the run cannot
 * finish (no recording, no budget, an error), the report goes back to waiting for staff as it was.
 */
export async function reanalyzeReport(rt: Runtime, reportId: string, analysisId: number): Promise<ReanalyzeResult> {
  const { database } = rt;
  const [latest] = await database.select({ id: reportAnalyses.id }).from(reportAnalyses).where(eq(reportAnalyses.report_id, reportId)).orderBy(desc(reportAnalyses.id)).limit(1);
  if (!latest || latest.id !== analysisId) throw new UserError("The report was analyzed again since this page loaded. Reload to see the latest suggestion.");
  const claimedAt = new Date().toISOString();
  const [report] = await database
    .update(reports)
    .set({ status: "analyzing", claimed_at: claimedAt })
    .where(and(eq(reports.id, reportId), eq(reports.status, "under_review"), verifyClaimFree()))
    .returning();
  if (!report) {
    const [exists] = await database.select({ status: reports.status }).from(reports).where(eq(reports.id, reportId));
    if (!exists) throw new UserError(`Unknown report ${reportId}`);
    if (exists.status !== "under_review") throw new UserError(`This report is ${exists.status.replace("_", " ")}; only a suggestion waiting for staff can be analyzed again.`);
    throw new UserError("A verification of this report is running. Wait for it to finish.");
  }
  try {
    await runAnalysis(rt, report, claimedAt);
    const [stored] = await database.select({ final: reportAnalyses.final }).from(reportAnalyses).where(eq(reportAnalyses.report_id, reportId)).orderBy(desc(reportAnalyses.id)).limit(1);
    return { status: "analyzed", label: (stored!.final as { label: Label }).label };
  } catch (err) {
    if (err instanceof LeaseLost) return { status: "superseded" };
    const restored = await database
      .update(reports)
      .set({ status: "under_review" })
      .where(and(eq(reports.id, reportId), eq(reports.status, "analyzing"), eq(reports.claimed_at, claimedAt)))
      .returning({ id: reports.id });
    if (restored.length === 0) return { status: "superseded" };
    if (err instanceof CacheMissError) return { status: "not_started", message: "The public demo has no prepared result for analyzing this report again. Enter the access code to run it live." };
    if (err instanceof LiveBudgetError) return { status: "not_started", message: err.message };
    console.error(`re-analysis of ${reportId} failed`, err);
    return { status: "not_started", message: "The analysis could not finish. The current suggestion is unchanged." };
  }
}

export type FactChange = {
  incident_id: string;
  was: { status: string; resolved_at: string | null };
  now: { status: string; resolved_at: string | null };
};

/**
 * Incidents whose state changed since the analysis read them: a repair recorded, a reopening. The rules
 * read that state (a report seen before a repair is late, one after it may be a recurrence), so a
 * suggestion made before the change is out of date, and the fix is to analyze again, not to verify.
 */
export function changedFacts(candidates: Candidate[], current: Array<{ id: string; status: string; resolved_at: string | null }>): FactChange[] {
  const sameTime = (a: string | null, b: string | null) => (a === null || b === null ? a === b : Date.parse(a) === Date.parse(b));
  // The rules tell open from fixed (open and in progress read the same) and read the repair time.
  const open = (status: string) => status === "open" || status === "in_progress";
  return candidates.flatMap((c) => {
    const now = current.find((i) => i.id === c.incident_id);
    if (!now || (open(now.status) === open(c.status) && sameTime(now.resolved_at, c.resolved_at))) return [];
    return [{ incident_id: c.incident_id, was: { status: c.status, resolved_at: c.resolved_at }, now: { status: now.status, resolved_at: now.resolved_at } }];
  });
}

async function runAnalysis(rt: Runtime, report: typeof reports.$inferSelect, claimedAt: string): Promise<{ status: string }> {
  const { database } = rt;
  const reportId = report.id;
  const photos = await database
    .select({ id: images.id })
    .from(images)
    .where(and(eq(images.report_id, reportId), eq(images.kind, "original")))
    .orderBy(asc(images.created_at), asc(images.id));
  // After an answer, whoever asked decides which photo the pipeline reads first (photoRoles) and which
  // photos are close-ups: the rule behind the question (a verification recheck can ask too), or staff.
  const [asked] = report.already_asked
    ? await database
        .select({ source: infoRequests.source, reason: infoRequests.reason_for_staff, items: infoRequests.requested_items })
        .from(infoRequests)
        .where(and(eq(infoRequests.report_id, reportId), eq(infoRequests.status, "answered")))
        .orderBy(desc(infoRequests.id))
        .limit(1)
    : [];

  const mode = await runMode(database, report, ANALYSIS_USD);
  let transcript = report.transcript;
  let transcriptUsd = 0;
  if (report.audio_path && transcript === null) {
    try {
      const audio = await rt.store.get(report.audio_path);
      const t = await metered(() => transcribe(audio, { mode }));
      transcript = t.result.transcript;
      transcriptUsd = t.usd;
      await database.update(reports).set({ transcript }).where(eq(reports.id, reportId));
    } catch (err) {
      // A resident who said someone is in danger reaches staff whether or not the recording could be read.
      if (!report.danger) throw err;
    }
  }
  const incoming: IncomingReport = {
    report_id: reportId,
    image_ids: photos.map((p) => p.id),
    lat: report.lat,
    lng: report.lng,
    observed_at: new Date(report.observed_at).toISOString(),
    text: messageText(report.description, transcript),
    category_hint: report.category_hint,
    already_asked: report.already_asked,
    asked_by: asked ? askedBy(asked) : null,
    danger: report.danger,
  };
  let result: ProcessResult;
  let unread: WordsUnread | null = null;
  try {
    result = await processReport(incoming, toolContext(rt, reportId, mode));
  } catch (err) {
    // A sample photo has a recorded reading, the words typed with it have none (or there is no budget left
    // to read them live). The photo is then analyzed alone, and both screens say the words went unread.
    // Words still reach staff, who read them themselves; the danger tick needs no model.
    if (!incoming.text || !(err instanceof CacheMissError || err instanceof LiveBudgetError)) throw err;
    unread = err instanceof CacheMissError ? "no_recording" : "budget";
    result = await processReport({ ...incoming, text: null }, toolContext(rt, reportId, mode));
  }

  const { photo, routed, final } = result;
  const analysis = photo?.analysis ?? null;
  const status = final.label === "NEEDS_INFO" ? "needs_info" : "under_review";
  // The analysis, the question and the new status land together or not at all.
  await database.transaction(async (tx) => {
    const [held] = await tx.select({ status: reports.status, claimed_at: reports.claimed_at }).from(reports).where(eq(reports.id, reportId)).for("update");
    if (held?.status !== "analyzing" || held.claimed_at === null || Date.parse(held.claimed_at) !== Date.parse(claimedAt)) throw new LeaseLost();
    const [stored] = await tx
      .insert(reportAnalyses)
      .values({
        report_id: reportId,
        pipeline_config: photo ? "C_rules" : "intake",
        prompt_hash: { ...analysis?.prompt_hash, ...(result.intake ? { intake: result.intake.prompt_hash } : {}) },
        triage: analysis?.triage ?? null,
        intake: result.intake?.result ?? null,
        candidates: result.candidates,
        comparisons: analysis?.comparisons ?? [],
        decision: analysis?.decision ?? routed!,
        final,
        input: photo?.input ?? null,
        after_fix: analysis?.after_fix ?? null,
        errors: [...(analysis?.errors ?? []), ...(unread ? [WORDS_NOT_READ[unread]] : [])],
        cost_usd: result.cost_usd + transcriptUsd,
        latency_ms: result.latency_ms,
      })
      .returning({ id: reportAnalyses.id });
    if (final.label === "NEEDS_INFO") await tx.insert(infoRequests).values(question(reportId, stored!.id, final, categoryOf(report, analysis?.triage ?? null, result.intake?.result ?? null)));
    await tx.update(reports).set({ status, error: null, ...(final.urgent ? { urgent: true } : {}) }).where(eq(reports.id, reportId));
  });
  return { status };
}

export type VerifyResult =
  | { status: "not_started"; reason: "no_recording" | "budget" | "error"; message: string }
  | { status: "facts_changed"; changes: FactChange[] }
  | { status: "applied"; run_status: string; label: Label; changed: boolean }
  | { status: "superseded"; run_status: string };

// What the verify route streams: each tool call as it finishes, then the result (or why it was refused).
export type VerifyEvent =
  | { type: "step"; step: Pick<AgentStep, "step" | "ref" | "tool" | "ok" | "error" | "args" | "data"> }
  | { type: "result"; result: VerifyResult }
  | { type: "error"; error: string };

const verifyClaimFree = () => or(isNull(reports.verify_claimed_at), lt(reports.verify_claimed_at, new Date(Date.now() - ANALYSIS_LEASE_MS).toISOString()));

/**
 * The stored analysis as the fast path left it, with the input it read. Its decision is the stored final (a
 * previous check may have made it more cautious), so an agent starts from the suggestion staff see. The
 * caller checks that the row has an input and a triage.
 */
export function storedAnalysis(latest: typeof reportAnalyses.$inferSelect): { input: ReportInput; analysis: Analysis } {
  const final = latest.final as { label: Label; incident_id: string | null; rule_id: string; missing_info: RequestItem[] };
  const analysis: Analysis = {
    pipeline_config: "C_rules",
    prompt_hash: latest.prompt_hash as Analysis["prompt_hash"],
    triage: latest.triage as Analysis["triage"],
    segmentation: null,
    candidates: latest.candidates as Analysis["candidates"],
    comparisons: latest.comparisons as Analysis["comparisons"],
    after_fix: (latest.after_fix as Analysis["after_fix"]) ?? null,
    errors: latest.errors as string[],
    decision: { ...(latest.decision as Analysis["decision"]), label: final.label, incident_id: final.incident_id, rule_id: final.rule_id, missing_info: final.missing_info as Analysis["decision"]["missing_info"] },
    cost_usd: latest.cost_usd,
    latency_ms: latest.latency_ms,
  };
  return { input: latest.input as ReportInput, analysis };
}

/**
 * Staff ask the verification agent to check the suggestion they are looking at (analysisId, the report's
 * latest analysis). One verification runs per report at a time (a lease like an analysis's claim). The
 * result applies only if, when it is stored, the report is still waiting for staff, the lease is still
 * ours and no newer analysis exists; otherwise the run is kept on record, marked not applied.
 */
export async function verifyReport(rt: Runtime, reportId: string, analysisId: number, onStep?: (step: AgentStep) => void): Promise<VerifyResult> {
  const { database } = rt;
  const claimedAt = new Date().toISOString();
  const [report] = await database
    .update(reports)
    .set({ verify_claimed_at: claimedAt })
    .where(and(eq(reports.id, reportId), eq(reports.status, "under_review"), verifyClaimFree()))
    .returning();
  if (!report) {
    const [exists] = await database.select({ status: reports.status }).from(reports).where(eq(reports.id, reportId));
    if (!exists) throw new UserError(`Unknown report ${reportId}`);
    if (exists.status !== "under_review") throw new UserError(`This report is ${exists.status.replace("_", " ")}; only a suggestion waiting for staff can be verified.`);
    throw new UserError("A verification of this report is already running.");
  }
  const ours = and(eq(reports.id, reportId), eq(reports.verify_claimed_at, claimedAt));
  const release = () => database.update(reports).set({ verify_claimed_at: null }).where(ours);
  try {
    const [latest] = await database.select().from(reportAnalyses).where(eq(reportAnalyses.report_id, reportId)).orderBy(desc(reportAnalyses.id)).limit(1);
    if (!latest || latest.id !== analysisId) throw new UserError("The report was analyzed again since this page loaded. Reload to verify the latest suggestion.");
    const final = latest.final as { label: Label; incident_id: string | null; rule_id: string; missing_info: RequestItem[] };
    if (!VERIFIED.has(final.label)) throw new UserError("Only a duplicate, late or already-fixed suggestion can be verified.");
    if (!latest.input || !latest.triage) throw new UserError("This analysis predates stored inputs. Analyze the report again to verify it.");
    const [{ value: runsSoFar }] = (await database.select({ value: count() }).from(agentRuns).where(eq(agentRuns.report_id, reportId))) as [{ value: number }];
    if (runsSoFar >= AGENT_LIMITS.max_runs_per_report) throw new UserError(`This report has had ${runsSoFar} verification runs, the most allowed.`);
    const stored = latest.candidates as Candidate[];
    const current = stored.length ? await database.select({ id: incidents.id, status: incidents.status, resolved_at: incidents.resolved_at }).from(incidents).where(inArray(incidents.id, stored.map((c) => c.incident_id))) : [];
    const changes = changedFacts(stored, current);
    if (changes.length) {
      await release();
      return { status: "facts_changed", changes };
    }

    const { input, analysis } = storedAnalysis(latest);
    const mode = await runMode(database, report, AGENT_LIMITS.max_usd);
    const checked = await verifySuggestion(input, analysis, toolContext(rt, reportId, mode), onStep);
    if (!checked.started) {
      await release();
      return { status: "not_started", reason: checked.reason, message: checked.message };
    }
    const { agent, decision } = checked;
    const status = decision.label === "NEEDS_INFO" ? "needs_info" : "under_review";
    return await database.transaction(async (tx) => {
      const [held] = await tx.select({ status: reports.status, verify_claimed_at: reports.verify_claimed_at }).from(reports).where(eq(reports.id, reportId)).for("update");
      const [newest] = await tx.select({ id: reportAnalyses.id }).from(reportAnalyses).where(eq(reportAnalyses.report_id, reportId)).orderBy(desc(reportAnalyses.id)).limit(1);
      const current = held?.status === "under_review" && held.verify_claimed_at !== null && Date.parse(held.verify_claimed_at) === Date.parse(claimedAt) && newest?.id === analysisId;
      const run = {
        report_id: reportId,
        analysis_id: analysisId,
        requested_by: "staff",
        applied: current,
        trigger: agent.trigger,
        status: agent.status,
        steps: agent.steps,
        proposal: agent.proposal,
        guard: agent.guard,
        question: agent.question,
        error: agent.error,
        cost_usd: agent.cost_usd,
        latency_ms: agent.latency_ms,
      };
      if (!current) {
        // A staff decision, a newer analysis or a taken-over lease came first: the run's cost and steps stay
        // on record, its result does not move the report.
        await tx.insert(agentRuns).values(run);
        await tx.update(reports).set({ verify_claimed_at: null }).where(ours);
        return { status: "superseded" as const, run_status: agent.status };
      }
      const [stored] = await tx
        .insert(reportAnalyses)
        .values({
          report_id: reportId,
          pipeline_config: "C_rules+verify",
          prompt_hash: { ...(latest.prompt_hash as Record<string, string>) },
          triage: latest.triage,
          intake: latest.intake,
          candidates: latest.candidates,
          comparisons: latest.comparisons,
          decision: latest.decision,
          final: { ...decision, urgent: false },
          input: latest.input,
          after_fix: latest.after_fix,
          errors: latest.errors,
          cost_usd: latest.cost_usd + agent.cost_usd,
          latency_ms: latest.latency_ms + agent.latency_ms,
        })
        .returning({ id: reportAnalyses.id });
      await tx.insert(agentRuns).values(run);
      if (decision.label === "NEEDS_INFO") {
        await tx.insert(infoRequests).values(question(reportId, stored!.id, decision, categoryOf(report, latest.triage as { category: Category }, latest.intake as IntakeResult | null)));
      }
      await tx.update(reports).set({ status, verify_claimed_at: null }).where(eq(reports.id, reportId));
      return { status: "applied" as const, run_status: agent.status, label: decision.label, changed: decision.label !== final.label || decision.incident_id !== final.incident_id };
    });
  } catch (err) {
    await release();
    throw err;
  }
}

// The one question a NEEDS_INFO decision asks the resident, in the template's words.
function question(reportId: string, analysisId: number, final: { rule_id: string; missing_info: RequestItem[] }, category: Category): typeof infoRequests.$inferInsert {
  const item = final.missing_info[0] ?? "wider_context";
  return { report_id: reportId, analysis_id: analysisId, question: templateQuestion(item, category), requested_items: final.missing_info, reason_for_staff: final.rule_id, source: "template", status: "pending" };
}

// What asked the resident, as the pipeline reads it: the rule's id, or the item staff asked for.
function askedBy(q: { source: string; reason: string | null; items: unknown }): string | null {
  if (q.source !== "staff") return q.reason;
  const [item] = q.items as RequestItem[];
  return staffAsk(item ?? "wider_context");
}

// What the report is about: the photo's reading, else the kind the resident picked, else their words.
function categoryOf(report: { category_hint: string | null }, triage: { category: Category } | null, intake: IntakeResult | null): Category {
  return triage?.category ?? (report.category_hint as Category | null) ?? intake?.category ?? "other";
}

/**
 * The resident answers the open question with a photo or the time they took the first one. The photo row,
 * the answered question and the new status are one locked transaction: of two answers sent at once, or an
 * answer racing a staff decision, the loser leaves no photo behind for the next analysis to read.
 */
export async function answerReport(rt: Runtime, reportId: string, answer: { observed_at: string } | { photo: Photo; access_code?: string | null }): Promise<void> {
  const { database } = rt;
  const [before] = await database.select({ live: reports.live }).from(reports).where(eq(reports.id, reportId));
  if (!before) throw new UserError(`Unknown report ${reportId}`);
  if ("photo" in answer && !("sample_id" in answer.photo) && !before.live && !accessCodeValid(answer.access_code)) {
    throw new UserError("Uploading your own photo needs the demo access code. Pick a sample photo instead.");
  }
  // An uploaded file may be left orphaned in the blob store if the answer loses; its row never exists.
  const row = "photo" in answer ? await photoRow(rt, reportId, answer.photo) : null;
  await database.transaction(async (tx) => {
    const [report] = await tx.select({ status: reports.status }).from(reports).where(eq(reports.id, reportId)).for("update");
    const [open] = await tx
      .select()
      .from(infoRequests)
      .where(and(eq(infoRequests.report_id, reportId), eq(infoRequests.status, "pending")))
      .orderBy(desc(infoRequests.id))
      .limit(1);
    if (report?.status !== "needs_info" || !open) throw new UserError("There is no open question for this report (it may have been answered already).");
    if (row) await tx.insert(images).values(row);
    // "answered" until the re-analysis claims it.
    await tx
      .update(reports)
      .set({ status: "answered", already_asked: true, ...("observed_at" in answer ? { observed_at: answer.observed_at, observed_at_source: "user" } : {}) })
      .where(eq(reports.id, reportId));
    await tx.update(infoRequests).set({ status: "answered", response: "photo" in answer ? { photo: true } : answer }).where(eq(infoRequests.id, open.id));
  });
}

export type StaffAction = "link" | "new_incident" | "recurrence" | "request_info" | "dismiss";

const SUGGESTS: Partial<Record<Label, StaffAction>> = {
  DUPLICATE: "link",
  LATE_REPORT: "link",
  ALREADY_RESOLVED: "link",
  NEW: "new_incident",
  POSSIBLE_RECURRENCE: "recurrence",
  NEEDS_INFO: "request_info",
};

// Staff can act on a report until it is decided, but not while an analysis is running or about to.
// A stale analysis (staleAnalysis) can be decided too; its late result is then discarded (LeaseLost).
const DECIDABLE = new Set(["received", "needs_info", "under_review", "unavailable", "failed"]);

/** One staff decision, all or nothing: the report row is locked, so a double click cannot open two incidents. */
/**
 * seen: what the staff member's screen showed when they chose (the console always sends it). A choice made on
 * an older suggestion, or before a change to an incident it relied on that the screen did not show, is
 * refused so staff see the latest first; a choice that differs from a suggestion they did see is theirs.
 */
export async function staffDecide(
  rt: Runtime,
  reportId: string,
  action: StaffAction,
  incidentId: string | null,
  item: RequestItem = "wider_context",
  seen?: { analysis_id: number | null; facts_changed_seen: boolean },
): Promise<void> {
  await rt.database.transaction(async (tx) => {
    const [report] = await tx.select().from(reports).where(eq(reports.id, reportId)).for("update");
    if (!report) throw new UserError(`Unknown report ${reportId}`);
    if (!DECIDABLE.has(report.status) && !staleAnalysis(report)) throw new UserError(`This report is ${report.status.replace("_", " ")}; nothing to decide now.`);
    if (action === "request_info" && report.status === "needs_info") throw new UserError("The resident has an open question already.");
    if (action === "link" || action === "recurrence") {
      if (!incidentId) throw new UserError(action === "link" ? "Linking needs an incident." : "A recurrence needs the incident it recurs from.");
      const [target] = await tx.select({ status: incidents.status }).from(incidents).where(eq(incidents.id, incidentId));
      if (!target) throw new UserError(`Unknown incident ${incidentId}`);
      if (action === "recurrence" && (target.status === "open" || target.status === "in_progress")) throw new UserError(`${incidentId} is still open, so nothing can recur from it yet.`);
    }
    const [analysis] = await tx.select().from(reportAnalyses).where(eq(reportAnalyses.report_id, reportId)).orderBy(desc(reportAnalyses.id)).limit(1);
    if (seen && (analysis?.id ?? null) !== seen.analysis_id) {
      throw new UserError("The suggestion changed since this page loaded (a verification or a new analysis). The latest is shown now; decide again.", "stale");
    }
    if (seen && analysis && !seen.facts_changed_seen) {
      const stored = analysis.candidates as Candidate[];
      const current = stored.length ? await tx.select({ id: incidents.id, status: incidents.status, resolved_at: incidents.resolved_at }).from(incidents).where(inArray(incidents.id, stored.map((c) => c.incident_id))) : [];
      if (changedFacts(stored, current).length) {
        throw new UserError("An incident this suggestion relied on changed since this page loaded. The latest is shown now; decide again.", "stale");
      }
    }
    const suggested = (analysis?.final as { label: Label; incident_id: string | null } | undefined) ?? null;
    const intake = (analysis?.intake as IntakeResult | null | undefined) ?? null;
    const category = categoryOf(report, report.triage as { category: Category } | null, intake);
    const now = new Date().toISOString();

    const openIncident = async (recurrenceOf: string | null) => {
      const newId = id("inc");
      const damage = (analysis?.triage as { damage_description?: string | null } | null | undefined)?.damage_description ?? intake?.problem;
      // Titles are read as names ("Compared with the …"): a recurrence keeps the fixture's name, a new incident
      // names its kind before the problem seen.
      const [parent] = recurrenceOf ? await tx.select({ title: incidents.title }).from(incidents).where(eq(incidents.id, recurrenceOf)) : [];
      const kind = category.replace("_", " ");
      const title = parent
        ? `${parent.title}, broken again`
        : damage
          ? `${kind} problem: ${damage.charAt(0).toLowerCase()}${damage.slice(1).replace(/\.$/, "")}`
          : `reported ${kind}`;
      await tx.insert(incidents).values({
        id: newId,
        category,
        status: "open",
        lat: report.lat,
        lng: report.lng,
        title,
        created_at: now,
        recurrence_of: recurrenceOf,
        representative_report_id: reportId,
      });
      await tx.insert(incidentEvents).values({
        incident_id: newId,
        type: recurrenceOf ? "recurrence_created" : "created",
        actor: "staff",
        summary: recurrenceOf ? `Opened as a recurrence of ${recurrenceOf}` : `Opened from report ${report.tracking_code}`,
      });
      return newId;
    };

    if (action === "link") {
      await tx.update(reports).set({ incident_id: incidentId, status: "linked" }).where(eq(reports.id, reportId));
      await tx.insert(incidentEvents).values({ incident_id: incidentId!, type: "report_linked", actor: "staff", summary: `Report ${report.tracking_code} linked` });
    } else if (action === "new_incident" || action === "recurrence") {
      const created = await openIncident(action === "recurrence" ? incidentId : null);
      await tx.update(reports).set({ incident_id: created, status: "new_incident" }).where(eq(reports.id, reportId));
    } else if (action === "request_info") {
      await tx.insert(infoRequests).values({
        report_id: reportId,
        analysis_id: analysis?.id ?? 0,
        question: templateQuestion(item, category),
        requested_items: [item],
        reason_for_staff: "Requested by staff",
        source: "staff",
        status: "pending",
      });
      await tx.update(reports).set({ status: "needs_info" }).where(eq(reports.id, reportId));
    } else {
      await tx.update(reports).set({ status: "dismissed" }).where(eq(reports.id, reportId));
    }

    const expected = suggested ? SUGGESTS[suggested.label] : undefined;
    const sameTarget = action === "link" || action === "recurrence" ? suggested?.incident_id === incidentId : true;
    await tx.insert(staffDecisions).values({
      report_id: reportId,
      analysis_id: analysis?.id ?? null,
      suggested: suggested?.label ?? "none",
      final_action: action,
      incident_id: incidentId,
      agreed: expected === action && sameTarget,
    });
  });
}

/**
 * Marks an open incident fixed, now or (for demo scenarios) at an earlier time. The repair time is what
 * separates a late report from a recurrence, so a second click never moves it.
 */
export async function recordRepair(rt: Runtime, incidentId: string, at = new Date().toISOString()): Promise<void> {
  await rt.database.transaction(async (tx) => {
    const fixed = await tx
      .update(incidents)
      .set({ status: "resolved", resolved_at: at })
      .where(and(eq(incidents.id, incidentId), inArray(incidents.status, ["open", "in_progress"])))
      .returning({ id: incidents.id });
    if (fixed.length === 0) throw new UserError(`${incidentId} is not open, so its repair time stays as recorded.`);
    await tx.insert(incidentEvents).values({ incident_id: incidentId, type: "repair_recorded", actor: "staff", summary: "Repair recorded by staff", created_at: at });
  });
}

// ---- reads for the screens ----

export async function reportDetail(rt: Runtime, reportId: string) {
  const { database } = rt;
  const [report] = await database.select().from(reports).where(eq(reports.id, reportId));
  if (!report) return null;
  const [analyses, runs, briefRows, questions, photos] = await Promise.all([
    database.select().from(reportAnalyses).where(eq(reportAnalyses.report_id, reportId)).orderBy(desc(reportAnalyses.id)),
    database.select().from(agentRuns).where(eq(agentRuns.report_id, reportId)).orderBy(asc(agentRuns.id)),
    database.select().from(briefs).where(eq(briefs.report_id, reportId)).orderBy(asc(briefs.id)),
    database.select().from(infoRequests).where(eq(infoRequests.report_id, reportId)).orderBy(asc(infoRequests.id)),
    database.select().from(images).where(and(eq(images.report_id, reportId), eq(images.kind, "original"))).orderBy(asc(images.created_at), asc(images.id)),
  ]);
  const latest = analyses[0] ?? null;
  const candidateIds = ((latest?.candidates as Array<{ incident_id: string }> | undefined) ?? []).map((c) => c.incident_id);
  const imageIds = new Set<string>(photos.map((p) => p.id));
  for (const c of (latest?.comparisons as Array<{ candidate_image_id: string }> | undefined) ?? []) imageIds.add(c.candidate_image_id);
  const [candidateIncidents, segs, compared] = await Promise.all([
    candidateIds.length ? database.select().from(incidents).where(inArray(incidents.id, candidateIds)) : Promise.resolve([]),
    imageIds.size ? database.select().from(segmentations).where(inArray(segmentations.image_id, [...imageIds])).orderBy(desc(segmentations.id)) : Promise.resolve([]),
    imageIds.size ? database.select({ id: images.id, is_synthetic: images.is_synthetic, width: images.width, height: images.height }).from(images).where(inArray(images.id, [...imageIds])) : Promise.resolve([]),
  ]);
  const latestSeg = new Map<string, (typeof segs)[number]>();
  for (const s of segs) if (!latestSeg.has(s.image_id)) latestSeg.set(s.image_id, s);
  // Each nearby incident's first photo, for reports that were never compared (no photo, or an emergency).
  const reps = candidateIncidents.map((i) => i.representative_report_id).filter((r): r is string => r !== null);
  const repPhotos = reps.length ? await database.select().from(images).where(and(inArray(images.report_id, reps), eq(images.kind, "original"))).orderBy(asc(images.created_at)) : [];
  const incidentPhotos: Record<string, (typeof repPhotos)[number]> = {};
  for (const i of candidateIncidents) {
    const photo = repPhotos.find((p) => p.report_id === i.representative_report_id);
    if (photo) incidentPhotos[i.id] = photo;
  }
  // Whether each compared photo is synthetic, and its size: real uploads are neither 1920×1280 nor synthetic.
  const imageFacts = Object.fromEntries(compared.map((i) => [i.id, i]));
  return { report, analysis: latest, runs, briefs: briefRows, questions, photos, incidents: candidateIncidents, incidentPhotos, imageFacts, segmentations: Object.fromEntries(latestSeg) };
}

export async function reportByCode(rt: Runtime, code: string) {
  const [report] = await rt.database.select({ id: reports.id }).from(reports).where(eq(reports.tracking_code, code.toUpperCase()));
  return report ? reportDetail(rt, report.id) : null;
}

const QUEUE_LIMIT = 200; // the console refreshes every few seconds; the demo world resets long before this fills

export async function queue(rt: Runtime) {
  const { database } = rt;
  const rows = await database.select().from(reports).orderBy(desc(reports.submitted_at)).limit(QUEUE_LIMIT);
  const analyses = rows.length
    ? await database.select().from(reportAnalyses).where(inArray(reportAnalyses.report_id, rows.map((r) => r.id))).orderBy(desc(reportAnalyses.id))
    : [];
  const latest = new Map<string, (typeof analyses)[number]>();
  for (const a of analyses) if (!latest.has(a.report_id)) latest.set(a.report_id, a);
  // Each report's first photo, for the row's thumbnail.
  const photos = rows.length
    ? await database
        .select({ id: images.id, report_id: images.report_id, is_synthetic: images.is_synthetic })
        .from(images)
        .where(and(inArray(images.report_id, rows.map((r) => r.id)), eq(images.kind, "original")))
        .orderBy(asc(images.created_at), asc(images.id))
    : [];
  const first = new Map<string, (typeof photos)[number]>();
  for (const p of photos) if (!first.has(p.report_id)) first.set(p.report_id, p);
  return rows.map((r) => ({ report: r, analysis: latest.get(r.id) ?? null, photo: first.get(r.id) ?? null }));
}

/** Every incident's place and state, for the console map. */
export async function mapIncidents(rt: Runtime) {
  return rt.database
    .select({ id: incidents.id, lat: incidents.lat, lng: incidents.lng, status: incidents.status, category: incidents.category, title: incidents.title, recurrence_of: incidents.recurrence_of })
    .from(incidents);
}

/** Incident titles by id, for screens that name incidents a run came across. */
export async function incidentTitles(rt: Runtime, ids: string[]): Promise<Record<string, string>> {
  if (ids.length === 0) return {};
  const rows = await rt.database.select({ id: incidents.id, title: incidents.title }).from(incidents).where(inArray(incidents.id, ids));
  return Object.fromEntries(rows.map((r) => [r.id, r.title]));
}

export async function incidentDetail(rt: Runtime, incidentId: string) {
  const { database } = rt;
  const [incident] = await database.select().from(incidents).where(eq(incidents.id, incidentId));
  if (!incident) return null;
  const [events, linked, chain] = await Promise.all([
    database.select().from(incidentEvents).where(eq(incidentEvents.incident_id, incidentId)).orderBy(asc(incidentEvents.created_at), asc(incidentEvents.id)),
    database.select().from(reports).where(eq(reports.incident_id, incidentId)).orderBy(asc(reports.observed_at)),
    database.select().from(incidents).where(eq(incidents.recurrence_of, incidentId)),
  ]);
  const photos = linked.length
    ? await database.select().from(images).where(and(inArray(images.report_id, linked.map((r) => r.id)), eq(images.kind, "original")))
    : [];
  return { incident, events, reports: linked, photos, recurrences: chain };
}
