// Author: HyeonMo Gu
// Created: 2026-10-27

// Fixture builders for the decision tables. R is the repair time; at("-2d") is two days before it.
import type { CompareResult, IncidentStatus, MissingItem } from "../../tools/types";
import type { Candidate, Comparison, DecideConfig, DecideInput } from "../decide";

export const R = "2026-11-01T12:00:00.000Z";

// Fixed here, not read from config.ts, so boundary cases stay put when thresholds are tuned.
export const TEST_CONFIG: DecideConfig = { match_conf: 0.75, no_match_conf: 0.6, time_margin_h: 6, sig_uncertain_factor: 0.8 };

const UNIT_MS = { d: 86_400_000, h: 3_600_000, m: 60_000 } as const;

/** R shifted by an offset such as "-2d", "+6h" or "-6h-1m". */
export function at(offset: string): string {
  let ms = Date.parse(R);
  for (const [, n, unit] of offset.matchAll(/([+-]?\d+)([dhm])/g)) ms += Number(n) * UNIT_MS[unit as keyof typeof UNIT_MS];
  return new Date(ms).toISOString();
}

/** Candidate incident created 3 days before R; resolved/closed ones were repaired at R. */
export function cand(id: string, status: IncidentStatus, extra: Partial<Candidate> = {}): Candidate {
  const repaired = status === "resolved" || status === "closed";
  return { incident_id: id, status, created_at: at("-3d"), resolved_at: repaired ? R : null, recurrence_of: null, distance_m: 12, ...extra };
}

type CmpOpts = {
  stage?: 1 | 2;
  dmg?: boolean;
  sig?: "same" | "different" | "uncertain";
  rep?: boolean;
  missing?: MissingItem[];
};

let imageSeq = 0;

/** Comparison against a photo of incident `id`. Defaults: crops, damage present, same signature, no repair signs. */
export function cmp(
  id: string,
  verdict: CompareResult["asset_match"]["verdict"],
  confidence: number,
  { stage = 2, dmg = true, sig = "same", rep = false, missing = [] }: CmpOpts = {},
): Comparison {
  return {
    incident_id: id,
    stage,
    candidate_image_id: `img_${id}_${++imageSeq}`,
    result: {
      asset_match: { verdict, confidence, evidence: [] },
      damage: {
        new_damage_present: dmg,
        candidate_damage_present: true,
        same_damage_signature: sig,
        repair_signs_in_new: rep,
        evidence: [],
      },
      view_change: "different_angle",
      missing_info: missing,
      summary: "",
    },
  };
}

/** A comparison call that failed. */
export function failed(id: string, stage: 1 | 2 = 2): Comparison {
  return { incident_id: id, stage, candidate_image_id: `img_${id}_${++imageSeq}`, result: null };
}

export function input({
  candidates = [],
  comparisons = [],
  observed = at("+0d"),
  asked = false,
  quality = "ok",
}: {
  candidates?: Candidate[];
  comparisons?: Comparison[];
  observed?: string;
  asked?: boolean;
  quality?: DecideInput["triage"]["image_quality"];
} = {}): DecideInput {
  return {
    report: { observed_at: observed, already_asked: asked },
    triage: { image_quality: quality },
    candidates,
    comparisons,
    config: TEST_CONFIG,
  };
}

export function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === "object") {
    for (const v of Object.values(value)) deepFreeze(v);
    Object.freeze(value);
  }
  return value;
}
