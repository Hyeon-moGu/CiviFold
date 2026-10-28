// Author: HyeonMo Gu
// Created: 2026-10-27

import type { AssetFile } from "../dataset/assets";
import type { Mode } from "../meta/call";
import { analyze, withAnswerPhoto, type ReportInput } from "../pipeline/analyze";
import { analyzeHybrid, type HybridResult } from "../pipeline/hybrid";
import { memoryData } from "../tools/data";
import { memoryImages, type ImageRow } from "../tools/images";
import type { CompareResult, MissingItem, ToolContext } from "../tools/types";
import type { Case } from "./cases";
import { geoBaseline, withStage } from "./ablations";
import { degrade } from "./degrade";
import { classify, type Outcome, type Prediction } from "./metrics";
import { worldAt } from "./world";

// baseline_geo: location only. A_full_image / B_sam_crops: the rules on full-photo or crop comparisons only.
// C_rules: the fast path. D_hybrid: the fast path with the investigation agent (the app).
export const CONFIGS = ["baseline_geo", "A_full_image", "B_sam_crops", "C_rules", "D_hybrid"] as const;
export type Config = (typeof CONFIGS)[number];

export type LoadImage = (id: string) => Promise<{ bytes: Buffer; width: number; height: number; mime: string }>;

export type CaseResult = {
  case_id: string;
  asset_id: string;
  set: Case["set"];
  kind: string;
  expected: Prediction;
  first: { label: string; rule_id: string; missing_info: MissingItem[] };
  asked: MissingItem | null;
  predicted: Prediction & { rule_id: string; confidence: number; rules: string[] }; // rules: every rule that fired, in order
  outcome: Outcome;
  comparisons: Array<{ incident_id: string; stage: 1 | 2; verdict: string | null; confidence: number | null }>;
  agent_runs: Array<{
    status: string;
    tools: string[];
    blocked_rules: string[];
    final_label: string;
    error: string | null;
    cost_usd: number;
    proposal: { label: string; incident_id: string | null } | null;
    // What each comparison of the run saw: the evidence the rules rechecked.
    compares: Array<{ new_image_id: string; candidate_image_id: string; mode: string; verdict: string; confidence: number; problem_visible: boolean }>;
  }>;
  errors: string[];
  cost_usd: number;
  latency_ms: number;
};

// The simulated resident answers one item: the true time first, otherwise a wider or closer photo.
function pickAnswer(missing: MissingItem[]): MissingItem | null {
  for (const item of ["observed_time", "wider_context", "different_angle", "close_up"] as const) if (missing.includes(item)) return item;
  return null;
}

export async function evaluateCase(c: Case, file: AssetFile, loadImage: LoadImage, mode: Mode, config: Config = "C_rules"): Promise<CaseResult> {
  const world = worldAt(file, c.submitted_at);
  const reportId = `report:${c.id}`;
  const row = async (id: string, report_id: string, as = id, transform = c.transform): Promise<{ row: ImageRow; bytes: Buffer }> => {
    const original = await loadImage(id);
    const img = transform ? await degrade(original.bytes, transform) : original;
    return { row: { id: as, report_id, kind: "original", source_image_id: null, width: img.width, height: img.height, mime: img.mime, is_synthetic: true }, bytes: img.bytes };
  };
  // The report's own photo gets a case-scoped id: the same file may already be an incident photo in the world.
  const seed = await Promise.all([
    ...world.photos.map((p) => row(p.image_id, p.report_id, p.image_id, null)),
    row(c.image_id, reportId, `${c.image_id}@${c.id}`),
    // The resident's answer is a fresh photo, so a degraded first photo does not carry over.
    row(c.answers.wider_context, reportId, `${c.answers.wider_context}@${c.id}:wide`, null),
    row(c.answers.close_up, reportId, `${c.answers.close_up}@${c.id}:close`, null),
  ]);
  const ctx: ToolContext = {
    reportId,
    runId: null,
    mode,
    budget: { usdLeft: Infinity, deadline: Infinity },
    data: memoryData({ asOf: c.submitted_at, incidents: world.incidents, events: world.events, photos: world.photos }),
    images: memoryImages({ images: seed, incidentByReport: world.incidentByReport }),
  };
  const report = {
    report_id: reportId,
    image_id: `${c.image_id}@${c.id}`,
    ...c.location,
    observed_at: c.observed_at,
    description: null,
    category_hint: c.category_hint,
    already_asked: false,
  };

  // C_rules stops at the fast path; D_hybrid lets the agent take what the fast path leaves open.
  const run = async (r: ReportInput, agentRuns: number): Promise<HybridResult> => {
    if (config === "D_hybrid") return analyzeHybrid(r, ctx, agentRuns);
    const analysis =
      config === "baseline_geo"
        ? await geoBaseline(r, ctx)
        : config === "A_full_image"
          ? withStage(await analyze(r, ctx), r, 1)
          : config === "B_sam_crops"
            ? withStage(await analyze(r, ctx), r, 2)
            : await analyze(r, ctx);
    const d = analysis.decision;
    return { analysis, agent: null, decision: { label: d.label, incident_id: d.incident_id, rule_id: d.rule_id, missing_info: d.missing_info } };
  };

  const first = await run(report, 0);
  let final = first;
  const asked = first.decision.label === "NEEDS_INFO" ? pickAnswer(first.decision.missing_info) : null;
  const runsSoFar = first.agent ? 1 : 0;
  if (asked === "observed_time") {
    final = await run({ ...report, observed_at: c.true_observed_at, already_asked: true }, runsSoFar);
  } else if (asked) {
    const photo = asked === "close_up" ? `${c.answers.close_up}@${c.id}:close` : `${c.answers.wider_context}@${c.id}:wide`;
    final = await run(withAnswerPhoto(report, first.decision, photo), runsSoFar);
  }
  const both = final === first ? [first] : [first, final];

  const d = final.decision;
  const predicted = { label: d.label, incident: d.incident_id };
  const confidence = final.agent ? (final.agent.proposal?.confidence ?? 0) : final.analysis.decision.confidence;
  return {
    case_id: c.id,
    asset_id: c.asset_id,
    set: c.set,
    kind: c.kind,
    expected: c.expected,
    first: { label: first.decision.label, rule_id: first.decision.rule_id, missing_info: first.decision.missing_info },
    asked,
    predicted: { ...predicted, rule_id: d.rule_id, confidence, rules: final.analysis.decision.reasons.map((r) => r.rule_id) },
    outcome: classify(c.expected, predicted),
    comparisons: final.analysis.comparisons.map((x) => ({
      incident_id: x.incident_id,
      stage: x.stage,
      verdict: x.result?.asset_match.verdict ?? null,
      confidence: x.result?.asset_match.confidence ?? null,
    })),
    agent_runs: both.flatMap((r) =>
      r.agent
        ? [
            {
              status: r.agent.status,
              tools: r.agent.steps.map((s) => s.tool),
              blocked_rules: r.agent.guard?.blocked_rules ?? [],
              final_label: r.agent.final.label,
              error: r.agent.error,
              cost_usd: r.agent.cost_usd,
              proposal: r.agent.proposal ? { label: r.agent.proposal.label, incident_id: r.agent.proposal.incident_id } : null,
              compares: r.agent.steps.flatMap((s) => {
                if (s.tool !== "compare_images" || !s.ok) return [];
                const args = s.args as { new_image_id: string; candidate_image_id: string };
                const data = s.data as CompareResult & { mode: string };
                return [{ new_image_id: args.new_image_id, candidate_image_id: args.candidate_image_id, mode: data.mode, verdict: data.asset_match.verdict, confidence: data.asset_match.confidence, problem_visible: data.damage.new_damage_present }];
              }),
            },
          ]
        : [],
    ),
    errors: both.flatMap((r) => r.analysis.errors),
    cost_usd: both.reduce((sum, r) => sum + r.analysis.cost_usd + (r.agent?.cost_usd ?? 0), 0),
    latency_ms: both.reduce((sum, r) => sum + r.analysis.latency_ms + (r.agent?.latency_ms ?? 0), 0),
  };
}
