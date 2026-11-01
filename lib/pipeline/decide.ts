// Author: HyeonMo Gu
// Created: 2026-10-27

// Decision engine. Pure function: no I/O, no model calls, no clock.
// The model judges what the photos show; these rules judge time and incident state.
// Rule ids (R0–R7z, R2c, R2v, R2w, R4g, R7r, P1) are recorded in every decision and mirrored in decide.test.ts.
import type { CompareResult, IncidentStatus, Label, MissingItem } from "../tools/types";

export type DecideConfig = {
  match_conf: number;
  no_match_conf: number;
  time_margin_h: number;
  sig_uncertain_factor: number;
};

export type Candidate = {
  incident_id: string;
  status: IncidentStatus;
  created_at: string;
  resolved_at: string | null;
  recurrence_of: string | null;
  distance_m: number;
};

export type Comparison = {
  incident_id: string;
  stage: 1 | 2; // 1 = full photos, 2 = SAM crops
  new_image_id: string; // a report can hold several photos (an answer to a question adds one)
  candidate_image_id: string;
  result: CompareResult | null; // null = the call failed
  fallback?: boolean; // crops were asked for, SAM found nothing, the full photos were compared again
};

export type DecideInput = {
  // close_up_ids: photos the resident sent because a rule asked for a close-up; they, not the first photo, show the problem.
  report: { observed_at: string; already_asked: boolean; close_up_ids?: string[] };
  triage: { image_quality: "ok" | "blurry" | "object_not_visible" | "too_far"; out_of_scope: boolean };
  candidates: Candidate[];
  comparisons: Comparison[];
  // The zoomed after-fix check per photo of the report (lib/pipeline/after-fix.ts), when it ran.
  after_fix?: Record<string, { problem_found: boolean }> | null;
  config: DecideConfig;
};

export type Reason = { rule_id: string; text: string };

export type Decision = {
  label: Label;
  incident_id: string | null;
  rule_id: string; // the rule that produced the final label
  reasons: Reason[]; // every rule that fired, in order
  confidence: number;
  missing_info: MissingItem[];
};

type Assessed =
  | {
      candidate: Candidate;
      verdict: "MATCH" | "NO_MATCH";
      result: CompareResult;
      problemFromOtherPhoto?: boolean;
      problemStage?: 1 | 2; // set with problemFromOtherPhoto when the reading is another stage of the same photo
      closeUpRead?: boolean;
      problemDisputed?: boolean;
      identityStrong?: boolean;
      fixConfirmed?: boolean;
      contradicted?: boolean;
    }
  | { candidate: Candidate; verdict: "UNCERTAIN"; result: CompareResult | null; conflict: boolean };
type Matched = Extract<Assessed, { verdict: "MATCH" | "NO_MATCH" }>;

const HOUR_MS = 3_600_000;

export function decide(input: DecideInput): Decision {
  const decision = applyRules(input);
  // P1: never ask the resident twice.
  if (decision.label !== "NEEDS_INFO" || !input.report.already_asked) return decision;
  return {
    ...decision,
    label: "HUMAN_REVIEW",
    rule_id: "P1",
    reasons: [...decision.reasons, { rule_id: "P1", text: "The resident was already asked once, so staff should review." }],
    missing_info: [],
  };
}

function applyRules(input: DecideInput): Decision {
  const { triage, candidates, config } = input;

  // R0s: complaints about people or behavior are never matched by image; staff handle them.
  if (triage.out_of_scope) {
    return decision("HUMAN_REVIEW", null, "R0s", "The report is about people or behavior, which is outside image matching.", 0);
  }

  // R0: a photo with nothing to compare stops here. A distant photo still goes on to matching:
  // it can identify the asset, and R7t asks for a close-up only where damage detail decides the label.
  if (triage.image_quality === "blurry" || triage.image_quality === "object_not_visible") {
    const item = triage.image_quality === "object_not_visible" ? "wider_context" : "close_up";
    return needsInfo("R0", `Photo quality is "${triage.image_quality}".`, [item], 0);
  }

  // R1
  if (candidates.length === 0) return decision("NEW", null, "R1", "No existing incident nearby.", 1);

  // R2: classify each candidate from its aggregated comparison.
  const closeUps = new Set(input.report.close_up_ids ?? []);
  const assessed = candidates.map((c) => assess(c, input.comparisons, closeUps, config));
  const matches = assessed.filter((a): a is Matched => a.verdict === "MATCH");
  const noMatches = assessed.filter((a): a is Matched => a.verdict === "NO_MATCH");

  // R3
  if (noMatches.length === assessed.length) {
    const confidence = Math.min(...noMatches.map((a) => a.result.asset_match.confidence));
    return decision("NEW", null, "R3", `All ${assessed.length} nearby incidents show a different place or fixture.`, confidence);
  }

  // R5: nothing matches, at least one candidate is uncertain.
  if (matches.length === 0) {
    const ids = assessed.filter((a) => a.verdict === "UNCERTAIN").map((a) => a.candidate.incident_id);
    if (input.report.already_asked) {
      return decision("HUMAN_REVIEW", null, "R5", `Still uncertain about ${ids.join(", ")} after asking once.`, 0);
    }
    const missing = [...new Set(assessed.flatMap((a) => (a.verdict === "UNCERTAIN" ? (a.result?.missing_info ?? []) : [])))];
    const conflicts = assessed.filter((a) => a.verdict === "UNCERTAIN" && a.conflict).map((a) => a.candidate.incident_id);
    const why = conflicts.length > 0 ? ` Full photos and crops disagree for ${conflicts.join(", ")}.` : "";
    return needsInfo("R5", `Not sure whether this is the same place or fixture as ${ids.join(", ")}.${why}`, missing.length > 0 ? missing : ["wider_context"], 0);
  }

  // R4 / R4c: several incidents match.
  const observedMs = Date.parse(input.report.observed_at);
  let best = matches[0]!;
  const chainReasons: Reason[] = [];
  if (matches.length > 1) {
    const ids = matches.map((m) => m.candidate.incident_id).join(", ");
    if (!isOneChain(matches.map((m) => m.candidate), candidates)) {
      return decision("HUMAN_REVIEW", null, "R4", `Matches several unrelated incidents: ${ids}.`, 0);
    }
    const covering = pickInChain(matches, observedMs);
    // R4g: the chain cannot place the observation in exactly one incident.
    if (!covering) return decision("HUMAN_REVIEW", null, "R4g", `${ids} are one recurrence chain, but the observation time falls in no single incident's interval.`, 0);
    best = covering;
    chainReasons.push({
      rule_id: "R4c",
      text: `${ids} are one recurrence chain; ${best.candidate.incident_id} covers the observation time.`,
    });
  }

  if (best.problemFromOtherPhoto) {
    // The reading may also come from the other comparison stage of the very photo that settled the identity.
    const from = best.closeUpRead
      ? "the close-up the resident sent"
      : best.problemStage !== undefined
        ? `the ${best.problemStage === 2 ? "cut-out" : "whole-photo"} comparison of the same photo`
        : "another photo of this report";
    chainReasons.push({ rule_id: "R2d", text: `The problem is judged from ${from}.` });
  }

  // R2c: the requested close-up shows no problem, another photo of the report does.
  if (best.problemDisputed) {
    const d = decision("HUMAN_REVIEW", best.candidate.incident_id, "R2c", "The close-up shows no problem, but another photo of this report does.", matchConfidence(best.result, config));
    return { ...d, reasons: [...chainReasons, ...d.reasons] };
  }

  // R7t stays until a close-up was actually read: a close-up whose comparisons failed answers nothing.
  const tooFar = triage.image_quality === "too_far" && !best.closeUpRead;
  const zoomFound = Object.values(input.after_fix ?? {}).some((r) => r.problem_found);
  const d = isOpen(best.candidate.status) ? openRules(best, config) : resolvedRules(best, observedMs, tooFar, zoomFound, config);
  const confirmed = confirmBurying(d, best);
  return { ...confirmed, reasons: [...chainReasons, ...confirmed.reasons] };
}

// Each photo of the report is judged on its own against the candidate: a sure crop comparison
// (stage 2) decides; when the crops are unsure (a tiny or recompressed subject leaves them little to see),
// a sure full-photo comparison (stage 1) decides instead. A photo whose comparisons are sure of opposite
// answers (across stages, or within one) counts as unsure. Photos sure of opposite answers make the
// candidate UNCERTAIN: confidence ranks evidence, it does not settle a contradiction (byStrength ranks).
// R2d: identity comes from the strongest matching photo; the problem from every photo that was never
// judged a different asset. When they disagree about the problem, the more cautious reading stands
// (a different problem over an uncertain one over the same one). When a rule asked for a close-up, the
// close-up alone shows the problem: the first photo's reading is what that rule did not trust.
function assess(candidate: Candidate, comparisons: Comparison[], closeUps: ReadonlySet<string>, config: DecideConfig): Assessed {
  const own = comparisons
    // A fallback repeats a full-photo comparison: counting it again would double one observation.
    .filter((c) => c.incident_id === candidate.incident_id && !c.fallback)
    .flatMap((c) =>
      c.result === null ? [] : [{ photo: c.new_image_id, stage: c.stage, result: c.result, key: `${c.new_image_id}|${c.candidate_image_id}|${c.stage}` }],
    )
    // Never by arrival order: a re-comparison of the same pair (same key) is ordered by its content.
    .sort((a, b) => a.key.localeCompare(b.key) || byStrength(a.result, b.result));
  const photos = [...new Set(own.map((c) => c.photo))];
  const judged = photos.map((photo) => ({ photo, ...judgePhoto(own.filter((c) => c.photo === photo), config) }));
  const strongest = (list: typeof judged) => [...list].sort((a, b) => byStrength(a.result!, b.result!))[0] ?? null;
  const matches = strongest(judged.filter((j) => j.verdict === "MATCH"));
  const noMatches = strongest(judged.filter((j) => j.verdict === "NO_MATCH"));

  if (matches && noMatches) return { candidate, verdict: "UNCERTAIN", result: matches.result, conflict: true };
  if (noMatches) return { candidate, verdict: "NO_MATCH", result: noMatches.result! };
  if (!matches) {
    const best = (stage: 1 | 2) => strongestResult(own.filter((c) => c.stage === stage).map((c) => c.result));
    return { candidate, verdict: "UNCERTAIN", result: best(2) ?? best(1), conflict: judged.some((j) => j.conflict) };
  }

  const result = matches.result!;
  const matching = judged.filter((j) => j.verdict === "MATCH");
  const identityStrong = matching.some((j) => j.byCrops) || matching.length >= 2;
  // Any sure "different asset", even inside a photo whose other stage disagreed, is evidence of a look-alike.
  const contradicted = own.some((c) => classify(c.result, config) === "NO_MATCH");
  const sawDifferent = new Set(own.filter((c) => c.result.asset_match.verdict === "different").map((c) => c.photo));
  const readable = own.filter((c) => !sawDifferent.has(c.photo));
  const closeUpReadings = readable.filter((c) => closeUps.has(c.photo));
  const sources = closeUpReadings.length > 0 ? closeUpReadings : readable;
  const shown = sources
    .filter((c) => c.result.damage.new_damage_present)
    .sort(
      (a, b) =>
        CAUTION[b.result.damage.same_damage_signature] - CAUTION[a.result.damage.same_damage_signature] || byStrength(a.result, b.result),
    )[0];
  const closeUpRead = closeUpReadings.length > 0;
  // A close-up that shows no problem still answers R7t: its reading (fixed or not) replaces the distant one.
  const reading = shown ?? (closeUpRead ? [...closeUpReadings].sort((a, b) => byStrength(a.result, b.result))[0]! : null);
  // ...unless the close-up shows no problem where another photo does: which one is right is for staff.
  const problemDisputed = closeUpRead && !shown && readable.some((c) => c.result.damage.new_damage_present);
  const fixPhotos = new Set(readable.filter((c) => !c.result.damage.new_damage_present && c.result.damage.repair_signs_in_new).map((c) => c.photo));
  const fixConfirmed = closeUpRead || fixPhotos.size >= 2;
  const facts = { closeUpRead, problemDisputed, identityStrong, fixConfirmed, contradicted };
  if (!reading || reading.result === result) return { candidate, verdict: "MATCH", result, ...facts };
  // A close-up with no problem in it confirms a fix another photo of the report shows signs of.
  const fixSeenElsewhere = !shown && closeUpRead && readable.some((c) => c.result.damage.repair_signs_in_new);
  const damage = fixSeenElsewhere ? { ...reading.result.damage, repair_signs_in_new: true } : reading.result.damage;
  const samePhoto = reading.photo === matches.photo;
  return { candidate, verdict: "MATCH", result: { ...result, damage }, problemFromOtherPhoto: true, ...(samePhoto ? { problemStage: reading.stage } : {}), ...facts };
}

// A different problem keeps a report out of the incident; an uncertain one at least lowers confidence.
const CAUTION: Record<CompareResult["damage"]["same_damage_signature"], number> = { different: 2, uncertain: 1, same: 0 };

type PhotoJudgement = { verdict: "MATCH" | "NO_MATCH" | "UNCERTAIN"; result: CompareResult | null; conflict: boolean; byCrops: boolean };

function judgePhoto(list: Array<{ stage: 1 | 2; result: CompareResult }>, config: DecideConfig): PhotoJudgement {
  const verdicts = list.map((c) => classify(c.result, config));
  if (verdicts.includes("MATCH") && verdicts.includes("NO_MATCH")) {
    return { verdict: "UNCERTAIN", result: strongestResult(list.filter((_, i) => verdicts[i] !== "UNCERTAIN").map((c) => c.result)), conflict: true, byCrops: false };
  }
  const best = (stage: 1 | 2) => {
    const inStage = list.filter((c) => c.stage === stage);
    const sure = inStage.filter((c) => classify(c.result, config) !== "UNCERTAIN");
    return strongestResult((sure.length > 0 ? sure : inStage).map((c) => c.result));
  };
  const [stage1, stage2] = [best(1), best(2)];
  const sure = (r: CompareResult | null) => (r && classify(r, config) !== "UNCERTAIN" ? r : null);
  const decisive = sure(stage2) ?? sure(stage1);
  if (decisive === null) return { verdict: "UNCERTAIN", result: stage2 ?? stage1, conflict: false, byCrops: false };
  return { verdict: classify(decisive, config) as "MATCH" | "NO_MATCH", result: decisive, conflict: false, byCrops: decisive === sure(stage2) };
}

function strongestResult(results: CompareResult[]): CompareResult | null {
  return [...results].sort(byStrength)[0] ?? null;
}

const VERDICT_CAUTION: Record<CompareResult["asset_match"]["verdict"], number> = { different: 2, uncertain: 1, same: 0 };

// Higher confidence first. Among equals the more cautious reading wins (doubt about the asset, a problem
// shown, a different problem, no sign of a fix), then the content itself: which comparison arrived first
// never decides a label.
function byStrength(a: CompareResult, b: CompareResult): number {
  return (
    b.asset_match.confidence - a.asset_match.confidence ||
    VERDICT_CAUTION[b.asset_match.verdict] - VERDICT_CAUTION[a.asset_match.verdict] ||
    Number(b.damage.new_damage_present) - Number(a.damage.new_damage_present) ||
    CAUTION[b.damage.same_damage_signature] - CAUTION[a.damage.same_damage_signature] ||
    Number(a.damage.repair_signs_in_new) - Number(b.damage.repair_signs_in_new) ||
    JSON.stringify(a).localeCompare(JSON.stringify(b))
  );
}

function classify(result: CompareResult, config: DecideConfig): "MATCH" | "NO_MATCH" | "UNCERTAIN" {
  const { verdict, confidence } = result.asset_match;
  if (verdict === "same" && confidence >= config.match_conf) return "MATCH";
  if (verdict === "different" && confidence >= config.no_match_conf) return "NO_MATCH";
  return "UNCERTAIN";
}

// True when every pair of incidents is linked through recurrence_of (one is an ancestor of the other).
function isOneChain(chain: Candidate[], all: Candidate[]): boolean {
  const byId = new Map(all.map((c) => [c.incident_id, c]));
  const ancestors = (c: Candidate) => {
    const seen = new Set<string>();
    for (let id = c.recurrence_of; id !== null && !seen.has(id); id = byId.get(id)?.recurrence_of ?? null) seen.add(id);
    return seen;
  };
  const lineage = new Map(chain.map((c) => [c.incident_id, ancestors(c)]));
  return chain.every((a) =>
    chain.every((b) => a === b || lineage.get(a.incident_id)!.has(b.incident_id) || lineage.get(b.incident_id)!.has(a.incident_id)),
  );
}

// The one incident whose [created_at, resolved_at) contains the observation, or null. created_at is when
// staff opened the incident, not when the problem began, so an observation in a gap between incidents
// (or before the first) could belong to either side, and overlapping intervals are bad data.
function pickInChain(matches: Matched[], observedMs: number): Matched | null {
  const covering = matches.filter(
    ({ candidate: c }) =>
      Date.parse(c.created_at) <= observedMs && (c.resolved_at === null || observedMs < Date.parse(c.resolved_at)),
  );
  return covering.length === 1 ? covering[0]! : null;
}

// Labels that let staff close a report in one click: wrong, they bury a problem. Each needs two
// independent observations; one look by the model, however confident, is not enough.
const BURYING: ReadonlySet<Label> = new Set(["DUPLICATE", "LATE_REPORT", "ALREADY_RESOLVED"]);

function confirmBurying(d: Decision, best: Matched): Decision {
  if (!BURYING.has(d.label)) return d;
  // R2v: a comparison was sure this is a different fixture or spot; a look-alike is not grouped on the others' word.
  if (best.contradicted) {
    const n = needsInfo("R2v", `A comparison judged this a different fixture or spot than ${d.incident_id}; it is not ${d.label === "DUPLICATE" ? "grouped" : "closed"} on the other comparisons' word.`, ["different_angle"], d.confidence);
    return { ...n, reasons: [...d.reasons, ...n.reasons] };
  }
  // R2w: identity from full photos alone (no sure crop comparison, no second matching photo).
  if (!best.identityStrong) {
    const n = needsInfo("R2w", `Only full photos tie this report to ${d.incident_id}; another view must confirm before it is ${d.label === "DUPLICATE" ? "grouped" : "closed"}.`, ["different_angle"], d.confidence);
    return { ...n, reasons: [...d.reasons, ...n.reasons] };
  }
  // R7r: "fixed" read from one photo is often a problem the photo cannot show (dark, small, low resolution).
  if (d.label === "ALREADY_RESOLVED" && !best.fixConfirmed) {
    const n = needsInfo("R7r", "The fix shows in one photo only; a close-up confirms it before the report is closed as already fixed.", ["close_up"], d.confidence);
    return { ...n, reasons: [...d.reasons, ...n.reasons] };
  }
  return d;
}

// R6: the matched incident is still open.
function openRules(best: Matched, config: DecideConfig): Decision {
  const id = best.candidate.incident_id;
  const { new_damage_present: dmg, same_damage_signature: sig, repair_signs_in_new: rep } = best.result.damage;
  const conf = matchConfidence(best.result, config);
  const asset = `Same place or fixture as ${id} (${best.result.asset_match.confidence.toFixed(2)})`;
  if (dmg && sig !== "different") return decision("DUPLICATE", id, "R6a", `${asset}, problem looks ${sig}, incident still open.`, conf);
  if (dmg) return decision("HUMAN_REVIEW", id, "R6b", `${asset}, but the problem differs from the open incident.`, conf);
  if (rep) return decision("HUMAN_REVIEW", id, "R6c", `${asset}, the problem looks fixed, yet the incident is open.`, conf);
  return needsInfo("R6d", `${asset}, but the problem is not visible.`, ["close_up"], conf);
}

// R7: the matched incident was resolved (repaired, cleaned or painted over). Δ = observed − resolved, with a ±margin of ambiguity.
function resolvedRules(best: Matched, observedMs: number, tooFar: boolean, zoomFound: boolean, config: DecideConfig): Decision {
  const c = best.candidate;
  const id = c.incident_id;
  const { new_damage_present: dmg, same_damage_signature: sig, repair_signs_in_new: rep } = best.result.damage;
  const conf = matchConfidence(best.result, config);
  if (c.resolved_at === null) {
    return decision("HUMAN_REVIEW", id, "R7h", `${id} is ${c.status} but has no resolution time.`, conf);
  }
  const deltaMs = observedMs - Date.parse(c.resolved_at);
  const marginMs = config.time_margin_h * HOUR_MS;
  const when = `${Math.round(Math.abs(deltaMs) / HOUR_MS)}h ${deltaMs < 0 ? "before" : "after"} ${id} was resolved`;

  if (deltaMs < -marginMs) {
    if (sig !== "different") return decision("LATE_REPORT", id, "R7a", `Observed ${when}, problem looks ${sig}.`, conf);
    return decision("HUMAN_REVIEW", id, "R7b", `Observed ${when}, but the problem differs.`, conf);
  }
  if (deltaMs > marginMs) {
    // R7z: the full photos showed no problem, the zoomed check of the same photos found one.
    if (!dmg && zoomFound) return decision("POSSIBLE_RECURRENCE", id, "R7z", `Observed ${when}; zoomed in, a photo shows a problem the full view missed.`, conf);
    // R7t: after a fix only the problem's detail separates a recurrence from a fixed one.
    if (tooFar) return needsInfo("R7t", `Observed ${when}, but the photo is too far to tell a new problem from the fix.`, ["close_up"], conf);
    if (!dmg && rep) return decision("ALREADY_RESOLVED", id, "R7c", `Observed ${when}, shows it fixed.`, conf);
    if (!dmg) return needsInfo("R7g", `Observed ${when}, but neither the problem nor the fix is visible.`, ["close_up"], conf);
    if (sig === "different") return decision("POSSIBLE_RECURRENCE", id, "R7d", `Observed ${when}, with a new problem.`, conf);
    if (sig === "same" && !rep) {
      return needsInfo("R7e", `Observed ${when}, yet shows the original problem and no fix; the photo may be older.`, ["observed_time"], conf);
    }
    return decision("POSSIBLE_RECURRENCE", id, "R7f", `Observed ${when}, the problem is back.`, conf);
  }
  return decision("HUMAN_REVIEW", id, "R7h", `Observed ${when}, within ±${config.time_margin_h}h.`, conf);
}

function isOpen(status: IncidentStatus): boolean {
  return status === "open" || status === "in_progress";
}

function matchConfidence(result: CompareResult, config: DecideConfig): number {
  const factor = result.damage.same_damage_signature === "uncertain" ? config.sig_uncertain_factor : 1;
  return round(result.asset_match.confidence * factor);
}

function round(x: number): number {
  return Math.round(x * 1000) / 1000;
}

function decision(label: Label, incidentId: string | null, ruleId: string, text: string, confidence: number): Decision {
  return { label, incident_id: incidentId, rule_id: ruleId, reasons: [{ rule_id: ruleId, text }], confidence, missing_info: [] };
}

function needsInfo(ruleId: string, text: string, missing: MissingItem[], confidence: number): Decision {
  return { ...decision("NEEDS_INFO", null, ruleId, text, confidence), missing_info: missing };
}
