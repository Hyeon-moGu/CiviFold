// Author: HyeonMo Gu
// Created: 2026-10-27

// Comparison configurations for the results table. baseline_geo makes no model call; A and B rerun the
// rules on half of the fast path's comparisons, so they reuse its (cached) calls and pay only for an answer
// photo they asked for and C_rules did not.
import { decideInputOf, toCandidate, type Analysis, type ReportInput } from "../pipeline/analyze";
import { SEARCH_CONFIG } from "../pipeline/config";
import { decide } from "../pipeline/decide";
import { searchIncidents } from "../tools/search-incidents";
import { Category, type ToolContext } from "../tools/types";

/**
 * The common rule a location-only system applies: any incident of the kind within the search radius
 * means the report is a duplicate of the nearest one, whatever its state or what the photo shows.
 */
export async function geoBaseline(report: ReportInput, ctx: ToolContext): Promise<Analysis> {
  const start = Date.now();
  const hint = Category.safeParse(report.category_hint);
  const category = hint.success ? hint.data : "other";
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
  const candidates = found.incidents.slice(0, SEARCH_CONFIG.max_candidates).map(toCandidate);
  const nearest = candidates[0];
  return {
    pipeline_config: "C_rules",
    prompt_hash: { triage: "", compare: "" },
    // No photo is read: the triage fields are placeholders the scoring never uses.
    triage: {
      out_of_scope: false,
      category,
      sam_prompt: "",
      damage_present: false,
      damage_description: null,
      repair_signs: false,
      context_landmarks: [],
      image_quality: "ok",
      severity: "low",
    },
    segmentation: null,
    candidates,
    comparisons: [],
    after_fix: null,
    errors: [],
    decision: nearest
      ? { label: "DUPLICATE", incident_id: nearest.incident_id, rule_id: "geo", reasons: [{ rule_id: "geo", text: `Nearest incident within ${SEARCH_CONFIG.radius_m[category]} m.` }], confidence: 1, missing_info: [] }
      : { label: "NEW", incident_id: null, rule_id: "geo", reasons: [{ rule_id: "geo", text: "No incident nearby." }], confidence: 1, missing_info: [] },
    cost_usd: 0,
    latency_ms: Date.now() - start,
  };
}

/** The same analysis judged by the rules on full-photo comparisons only (A) or crop comparisons only (B). */
export function withStage(analysis: Analysis, report: ReportInput, stage: 1 | 2): Analysis {
  const comparisons = analysis.comparisons.filter((c) => c.stage === stage);
  return { ...analysis, comparisons, decision: decide(decideInputOf(report, { ...analysis, comparisons })) };
}
