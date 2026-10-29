// Author: HyeonMo Gu
// Created: 2026-10-27

import { metered } from "../meta/call";
import { loadPrompt } from "../prompts";
import { compareImages } from "../tools/compare-images";
import { searchIncidents } from "../tools/search-incidents";
import { segmentObject } from "../tools/segment-object";
import { Category, type RequestItem, type ToolContext } from "../tools/types";
import { DECIDE_CONFIG, SEARCH_CONFIG } from "./config";
import { checkAfterFix, type AfterFixResult } from "./after-fix";
import { decide, type Candidate, type Comparison, type DecideInput, type Decision } from "./decide";
import { triage, type TriageResult } from "./triage";

export type ReportInput = {
  report_id: string;
  image_id: string; // the photo triage reads
  answer_image_ids?: string[]; // photos the resident added when asked; compared alongside image_id
  lat: number;
  lng: number;
  observed_at: string;
  description: string | null;
  category_hint: string | null;
  already_asked: boolean;
  asked_by?: string | null; // what asked the resident, once they answered: a rule id, or a staff request (staffAsk)
};

type SearchedIncident = Awaited<ReturnType<typeof searchIncidents.run>>["incidents"][number];

export type Analysis = {
  pipeline_config: "C_rules";
  prompt_hash: { triage: string; compare: string };
  triage: TriageResult;
  segmentation: Awaited<ReturnType<typeof segmentObject.run>> | null;
  candidates: Candidate[];
  comparisons: Comparison[];
  after_fix: Record<string, AfterFixResult> | null; // the zoomed after-fix check, when the rules needed it
  errors: string[]; // failed calls; decide() counts them as no result
  decision: Decision;
  cost_usd: number;
  latency_ms: number;
};

// The fast path: triage → candidate search → SAM → stage 1 (full photos) and stage 2 (crops)
// per candidate → rules. Only an out-of-scope or unusable photo stops before the search; after it, every
// candidate's first photo is compared with every photo of the report, in both stages, in parallel.
export async function analyze(report: ReportInput, ctx: ToolContext): Promise<Analysis> {
  const start = Date.now();
  const { result, usd } = await metered(() => fastPath(report, ctx));
  return { ...result, cost_usd: usd, latency_ms: Date.now() - start };
}

async function fastPath(report: ReportInput, ctx: ToolContext): Promise<Omit<Analysis, "cost_usd" | "latency_ms">> {
  const errors: string[] = [];

  const t = await triage(report.image_id, report, ctx);
  await ctx.images.saveTriage(report.report_id, { category: t.result.category, sam_prompt: t.result.sam_prompt });

  const finish = async (
    candidates: Candidate[],
    comparisons: Comparison[],
    segmentation: Analysis["segmentation"],
  ): Promise<Omit<Analysis, "cost_usd" | "latency_ms">> => {
    const facts = { triage: t.result, candidates, comparisons, after_fix: null };
    let decision = decide(decideInputOf(report, facts));
    // Before "already fixed" (or "neither problem nor fix visible") after a repair, look again in zoomed tiles.
    let afterFix: Analysis["after_fix"] = null;
    if (decision.reasons.some((r) => AFTER_FIX_RULES.has(r.rule_id))) {
      const photos = [report.image_id, ...(report.answer_image_ids ?? [])];
      afterFix = await checkAfterFix(photos, `${t.result.sam_prompt} (${t.result.category.replace("_", " ")})`, ctx, errors);
      decision = decide(decideInputOf(report, { ...facts, after_fix: afterFix }));
    }
    return {
      pipeline_config: "C_rules",
      prompt_hash: { triage: t.prompt_hash, compare: (await loadPrompt("compare")).hash },
      triage: t.result,
      segmentation,
      candidates,
      comparisons,
      after_fix: afterFix,
      errors,
      decision,
    };
  };

  // Out of scope (R0s) or nothing to compare in this photo (R0): no search, no SAM, no comparison.
  if (t.result.out_of_scope || t.result.image_quality === "blurry" || t.result.image_quality === "object_not_visible") {
    return finish([], [], null);
  }

  // The complaint type the resident picked outranks the photo: a cleaned spot or a busy scene can
  // show something else (a mural read as graffiti) and must still reach the incident it is about.
  const hint = Category.safeParse(report.category_hint);
  const category = hint.success ? hint.data : t.result.category;
  const found = await searchIncidents.run(
    {
      lat: report.lat,
      lng: report.lng,
      radius_m: SEARCH_CONFIG.radius_m[category],
      days_back: SEARCH_CONFIG.days_back,
      category: category === "other" ? null : category,
    },
    ctx,
  );
  const top = found.incidents.slice(0, SEARCH_CONFIG.max_candidates);
  const candidates = top.map(toCandidate);
  if (candidates.length === 0) return finish([], [], null);

  // Segment each of the report's photos once up front, so parallel crop comparisons reuse it.
  const photos = [report.image_id, ...(report.answer_image_ids ?? [])];
  const segmentations = await Promise.all(
    photos.map((id) =>
      segmentObject.run({ image_id: id, noun_phrase: t.result.sam_prompt }, ctx).catch((err) => {
        errors.push(`segment ${id}: ${String(err)}`);
        return null;
      }),
    ),
  );

  const pairs = top.flatMap((i) => (i.photo_ids[0] ? photos.map((own) => ({ incident_id: i.incident_id, own, photo: i.photo_ids[0]! })) : []));
  const comparisons = (
    await Promise.all(
      pairs.map(({ incident_id, own, photo }) =>
        Promise.all((["full", "crops"] as const).map((mode) => compareStage(incident_id, own, photo, mode, ctx, errors))),
      ),
    )
  ).flat();
  return finish(candidates, comparisons, segmentations[0] ?? null);
}

export function toCandidate(i: SearchedIncident): Candidate {
  return {
    incident_id: i.incident_id,
    status: i.status,
    created_at: i.created_at,
    resolved_at: i.resolved_at,
    recurrence_of: i.recurrence_of,
    distance_m: i.distance_m,
  };
}

/** A question staff asked, outside any rule, as `asked_by` records it. */
export const staffAsk = (item: RequestItem) => `staff:${item}`;

// Asks for a close-up of the problem, by a rule or by staff: the photo sent in reply is that close-up.
const CLOSE_UP_ASKS: ReadonlySet<string> = new Set(["R6d", "R7g", "R7t", "R7r", staffAsk("close_up")]);

const AFTER_FIX_RULES: ReadonlySet<string> = new Set(["R7c", "R7g"]);

/** The rules' input for this analysis, as the guardrail replays it with the agent's findings. */
export function decideInputOf(report: ReportInput, a: Pick<Analysis, "triage" | "candidates" | "comparisons"> & { after_fix?: Analysis["after_fix"] }): DecideInput {
  return {
    report: {
      observed_at: report.observed_at,
      already_asked: report.already_asked,
      close_up_ids: CLOSE_UP_ASKS.has(report.asked_by ?? "") ? (report.answer_image_ids ?? []) : [],
    },
    triage: { image_quality: a.triage.image_quality, out_of_scope: a.triage.out_of_scope },
    candidates: a.candidates,
    comparisons: a.comparisons,
    after_fix: a.after_fix ?? null,
    config: DECIDE_CONFIG,
  };
}

/**
 * Which of a report's photos (oldest first) the pipeline reads, the same for the evaluation and the app.
 * Added photos join the first one, which still identifies the place; only an unusable first photo (R0) is replaced.
 */
export function photoRoles(photoIds: readonly string[], askedBy: string | null): { image_id: string; answer_image_ids: string[] } {
  const [first, ...added] = photoIds;
  if (first === undefined) throw new Error("A report needs a photo to analyze");
  if (askedBy === "R0" && added.length > 0) return { image_id: added[0]!, answer_image_ids: added.slice(1) };
  return { image_id: first, answer_image_ids: added };
}

/** The report to re-analyze once the resident answered a question with a photo. */
export function withAnswerPhoto(report: ReportInput, first: Pick<Decision, "rule_id">, photoId: string): ReportInput {
  const photos = [report.image_id, ...(report.answer_image_ids ?? []), photoId];
  return { ...report, ...photoRoles(photos, first.rule_id), already_asked: true, asked_by: first.rule_id };
}

// A crops request that fell back to full photos is reported as stage 1 and marked, so it never outranks a
// real crop comparison nor counts as a second observation.
async function compareStage(
  incidentId: string,
  newImageId: string,
  candidateImageId: string,
  mode: "full" | "crops",
  ctx: ToolContext,
  errors: string[],
): Promise<Comparison> {
  try {
    const { candidate_incident_id, mode: used, ...result } = await compareImages.run(
      { new_image_id: newImageId, candidate_image_id: candidateImageId, mode },
      ctx,
    );
    return {
      incident_id: candidate_incident_id,
      stage: used === "crops" ? 2 : 1,
      new_image_id: newImageId,
      candidate_image_id: candidateImageId,
      result,
      ...(mode === "crops" && used !== "crops" ? { fallback: true } : {}),
    };
  } catch (err) {
    errors.push(`compare ${mode} ${newImageId} vs ${candidateImageId}: ${String(err)}`);
    return { incident_id: incidentId, stage: mode === "crops" ? 2 : 1, new_image_id: newImageId, candidate_image_id: candidateImageId, result: null };
  }
}
