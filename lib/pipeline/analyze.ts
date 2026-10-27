// Author: HyeonMo Gu
// Created: 2026-10-27

import { spent } from "../meta/call";
import { loadPrompt } from "../prompts";
import { compareImages } from "../tools/compare-images";
import { searchIncidents } from "../tools/search-incidents";
import { segmentObject } from "../tools/segment-object";
import type { ToolContext } from "../tools/types";
import { DECIDE_CONFIG, SEARCH_CONFIG } from "./config";
import { decide, type Candidate, type Comparison, type Decision } from "./decide";
import { triage, type TriageResult } from "./triage";

export type ReportInput = {
  report_id: string;
  image_id: string;
  lat: number;
  lng: number;
  observed_at: string;
  description: string | null;
  category_hint: string | null;
  already_asked: boolean;
};

export type Analysis = {
  pipeline_config: "C_rules";
  prompt_hash: { triage: string; compare: string };
  triage: TriageResult;
  segmentation: Awaited<ReturnType<typeof segmentObject.run>> | null;
  candidates: Candidate[];
  comparisons: Comparison[];
  errors: string[]; // failed calls; decide() counts them as no result
  decision: Decision;
  cost_usd: number;
  latency_ms: number;
};

// The fast path: triage → candidate search → SAM → stage 1 (full photos) and stage 2 (crops)
// per candidate → rules. Model calls stop as early as the rules allow.
export async function analyze(report: ReportInput, ctx: ToolContext): Promise<Analysis> {
  const start = Date.now();
  const spentBefore = spent();
  const errors: string[] = [];

  const t = await triage(report.image_id, report, ctx);
  await ctx.images.saveTriage(report.report_id, { category: t.result.category, sam_prompt: t.result.sam_prompt });

  const finish = async (candidates: Candidate[], comparisons: Comparison[], segmentation: Analysis["segmentation"]): Promise<Analysis> => ({
    pipeline_config: "C_rules",
    prompt_hash: { triage: t.prompt_hash, compare: (await loadPrompt("compare")).hash },
    triage: t.result,
    segmentation,
    candidates,
    comparisons,
    errors,
    decision: decide({
      report: { observed_at: report.observed_at, already_asked: report.already_asked },
      triage: { image_quality: t.result.image_quality },
      candidates,
      comparisons,
      config: DECIDE_CONFIG,
    }),
    cost_usd: spent() - spentBefore,
    latency_ms: Date.now() - start,
  });

  // Nothing to compare in this photo: R0 asks for a new one.
  if (t.result.image_quality === "blurry" || t.result.image_quality === "object_not_visible") return finish([], [], null);

  const category = t.result.category;
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
  const candidates: Candidate[] = top.map((i) => ({
    incident_id: i.incident_id,
    status: i.status,
    created_at: i.created_at,
    resolved_at: i.resolved_at,
    recurrence_of: i.recurrence_of,
    distance_m: i.distance_m,
  }));
  if (candidates.length === 0) return finish([], [], null);

  // Segment the new photo once up front, so parallel crop comparisons reuse it.
  const segmentation = await segmentObject.run({ image_id: report.image_id, noun_phrase: t.result.sam_prompt }, ctx).catch((err) => {
    errors.push(`segment ${report.image_id}: ${String(err)}`);
    return null;
  });

  const pairs = top.flatMap((i) => (i.photo_ids[0] ? [{ incident_id: i.incident_id, photo: i.photo_ids[0] }] : []));
  const comparisons = (
    await Promise.all(
      pairs.map(({ incident_id, photo }) =>
        Promise.all((["full", "crops"] as const).map((mode) => compareStage(incident_id, report.image_id, photo, mode, ctx, errors))),
      ),
    )
  ).flat();
  return finish(candidates, comparisons, segmentation);
}

// A crops request that fell back to full photos is reported as stage 1, so it never outranks a real crop comparison.
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
    return { incident_id: candidate_incident_id, stage: used === "crops" ? 2 : 1, candidate_image_id: candidateImageId, result };
  } catch (err) {
    errors.push(`compare ${mode} ${newImageId} vs ${candidateImageId}: ${String(err)}`);
    return { incident_id: incidentId, stage: mode === "crops" ? 2 : 1, candidate_image_id: candidateImageId, result: null };
  }
}
