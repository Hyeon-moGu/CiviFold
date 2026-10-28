// Author: HyeonMo Gu
// Created: 2026-10-27

// One report, whatever it came with: read the resident's words (if any), route emergencies and
// reports without a photo, and hand everything else to the photo pipeline unchanged. The app runs the fast
// path alone; staff can ask the verification agent to check a suggestion afterwards (verifySuggestion).
import { metered } from "../meta/call";
import { searchIncidents } from "../tools/search-incidents";
import { Category, type Label, type RequestItem, type ToolContext } from "../tools/types";
import { analyze, photoRoles, toCandidate, type Analysis, type ReportInput } from "./analyze";
import { SEARCH_CONFIG } from "./config";
import type { Candidate } from "./decide";
import { readIntake, type IntakeResult } from "./intake";
import { route, type RoutedDecision } from "./route";

export type IncomingReport = {
  report_id: string;
  image_ids: string[]; // the first identifies the place; later ones were added when asked
  lat: number;
  lng: number;
  observed_at: string;
  text: string | null; // typed description and transcript
  category_hint: string | null;
  already_asked: boolean;
  asked_by: string | null; // rule of the analysis that asked the resident, once they answered
  danger: boolean; // the resident ticked "someone may be in danger"
};

export type ProcessResult = {
  intake: { result: IntakeResult; prompt_hash: string } | null;
  routed: RoutedDecision | null;
  candidates: Candidate[]; // nearby incidents shown to staff for a routed report
  photo: { input: ReportInput; analysis: Analysis } | null; // the photo pipeline's reading, when it ran
  final: { label: Label; incident_id: string | null; rule_id: string; missing_info: RequestItem[]; urgent: boolean };
  cost_usd: number;
  latency_ms: number;
};

export async function processReport(report: IncomingReport, ctx: ToolContext): Promise<ProcessResult> {
  const start = Date.now();
  const { result, usd } = await metered(() => run(report, ctx));
  return { ...result, cost_usd: usd, latency_ms: Date.now() - start };
}

async function run(report: IncomingReport, ctx: ToolContext): Promise<Omit<ProcessResult, "cost_usd" | "latency_ms">> {
  // With the resident's danger tick the words only inform staff, so a failed read does not hold the report up.
  const read = report.text ? readIntake(report.text, ctx) : null;
  const intake = read && report.danger ? await read.catch(() => null) : await read;
  const words = intake?.result ?? null;
  const hasPhoto = report.image_ids.length > 0;

  // Staff see what is nearby for every report that skips the photo pipeline (except people and behavior).
  const emergency = report.danger || Boolean(words?.emergency);
  const skipsPhotos = !hasPhoto || emergency;
  const candidates = skipsPhotos && (emergency || !words?.out_of_scope) ? await nearby(report, words, ctx) : [];
  const routed = route({ has_photo: hasPhoto, danger: report.danger, intake: words, already_asked: report.already_asked, candidates });
  const kept = intake ? { result: intake.result, prompt_hash: intake.prompt_hash } : null;
  if (routed) {
    const { label, incident_id, rule_id, missing_info, urgent } = routed;
    return { intake: kept, routed, candidates, photo: null, final: { label, incident_id, rule_id, missing_info, urgent } };
  }

  const input: ReportInput = {
    report_id: report.report_id,
    ...photoRoles(report.image_ids, report.asked_by),
    lat: report.lat,
    lng: report.lng,
    observed_at: report.observed_at,
    description: report.text,
    category_hint: report.category_hint,
    already_asked: report.already_asked,
    asked_by: report.asked_by,
  };
  const analysis = await analyze(input, ctx);
  const d = analysis.decision;
  return {
    intake: kept,
    routed: null,
    candidates: analysis.candidates,
    photo: { input, analysis },
    final: { label: d.label, incident_id: d.incident_id, rule_id: d.rule_id, missing_info: d.missing_info, urgent: false },
  };
}

// The kind the resident picked outranks the one read from their words, as it does over the photo.
async function nearby(report: IncomingReport, words: IntakeResult | null, ctx: ToolContext): Promise<Candidate[]> {
  const hint = Category.safeParse(report.category_hint);
  const category = hint.success ? hint.data : (words?.category ?? "other");
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
  return found.incidents.slice(0, SEARCH_CONFIG.max_candidates).map(toCandidate);
}
