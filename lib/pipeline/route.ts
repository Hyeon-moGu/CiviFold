// Author: HyeonMo Gu
// Created: 2026-10-27

// Rules that run on the resident's words (and their danger tick) before any photo is compared. Pure, like
// decide.ts: a report with a photo, no emergency and nothing about people goes on to the photo pipeline unchanged.
import type { Label, RequestItem } from "../tools/types";
import type { Candidate, Reason } from "./decide";
import type { IntakeResult } from "./intake";

export type RouteInput = {
  has_photo: boolean;
  danger: boolean; // the resident ticked "someone may be in danger"
  intake: Pick<IntakeResult, "emergency" | "emergency_reason" | "out_of_scope"> | null; // null: no words to read
  already_asked: boolean;
  candidates: Candidate[]; // nearby incidents of the reported kind; searched only for reports without a photo
};

export type RoutedDecision = {
  label: Label;
  incident_id: null; // without a photo nothing is matched; staff see the nearby incidents instead
  rule_id: string;
  reasons: Reason[];
  confidence: number;
  missing_info: RequestItem[];
  urgent: boolean;
};

/** A decision for reports the photo pipeline cannot or should not take, else null. */
export function route(input: RouteInput): RoutedDecision | null {
  const { intake, candidates } = input;

  // R0e: possible immediate danger goes to staff at once, photo or not. Deduplication can wait.
  // The resident's own tick needs no model; a photo alone carries no emergency check (triage is not built for one).
  if (input.danger || intake?.emergency) {
    const why = input.danger ? "The resident said someone may be in danger." : (intake!.emergency_reason ?? "The message describes immediate danger.");
    return { ...routed("HUMAN_REVIEW", "R0e", `Possible emergency: ${why} The resident was told to call 911.`, 0), urgent: true };
  }

  // R0s: complaints about people or behavior go to staff. The words decide even with a photo: a photo
  // of the place the people stood would otherwise be matched as if it showed the problem.
  if (intake?.out_of_scope) return routed("HUMAN_REVIEW", "R0s", "The report is about people or behavior, which is outside image matching.", 0);
  if (input.has_photo) return null;

  if (intake === null) return routed("HUMAN_REVIEW", "R0n", "The report has no photo and no message to read.", 0);

  // R1p: with nothing of this kind nearby there is nothing to tell apart.
  if (candidates.length === 0) return routed("NEW", "R1p", "No photo, and no existing incident of this kind nearby.", 1);

  // R0p: words and GPS cannot separate an incident from a look-alike a few doors down; only a photo can.
  const ids = candidates.map((c) => `${c.incident_id} (${Math.round(c.distance_m)} m)`).join(", ");
  const text = `No photo. Nearby incidents of this kind: ${ids}. Only a photo can tell whether this is one of them.`;
  if (!input.already_asked) return { ...routed("NEEDS_INFO", "R0p", text, 0), missing_info: ["photo"] };
  // P1: never ask the resident twice.
  const d = routed("HUMAN_REVIEW", "P1", "The resident was already asked for a photo, so staff should review.", 0);
  return { ...d, reasons: [{ rule_id: "R0p", text }, ...d.reasons] };
}

function routed(label: Label, ruleId: string, text: string, confidence: number): RoutedDecision {
  return { label, incident_id: null, rule_id: ruleId, reasons: [{ rule_id: ruleId, text }], confidence, missing_info: [], urgent: false };
}
