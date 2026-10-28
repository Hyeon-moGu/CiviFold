// Author: HyeonMo Gu
// Created: 2026-10-27

// Every threshold lives here. Tune against the dev split only.
import type { Category } from "../tools/types";
import type { DecideConfig } from "./decide";

export const DECIDE_CONFIG: DecideConfig = {
  match_conf: 0.75, // same asset at or above this → MATCH
  no_match_conf: 0.6, // different asset at or above this → NO_MATCH
  time_margin_h: 6, // observations this close to a repair are ambiguous
  sig_uncertain_factor: 0.8, // confidence penalty when the damage signature is uncertain
};

export const COMPARE_CONFIG = {
  min_same_evidence: 2, // "same" with fewer distinctive evidence items is downgraded to uncertain
  weak_same_conf_cap: 0.5, // confidence ceiling after that downgrade
};

export const SEARCH_CONFIG = {
  radius_m: {
    fire_hydrant: 40,
    streetlight: 40,
    traffic_sign: 40,
    bench: 30,
    road_damage: 40,
    trash: 40,
    graffiti: 40,
    other: 40,
  } satisfies Record<Category, number>,
  days_back: 90, // resolved incidents older than this are not candidates
  max_candidates: 5,
  verify_radius_m: 60, // the verification agent is shown look-alikes this far away
};

export const AGENT_LIMITS = {
  max_steps: 8, // tool calls per run
  max_usd: 0.2, // per run, model and tool calls together; one crop comparison alone is about $0.018
  max_ms: 120_000, // per run
  closing_ms: 30_000, // with this little time left, the agent may only propose (or ask)
  max_runs_per_report: 2, // one before the resident answers, one after
  call_usd_estimate: 0.03,
  // The verifier's own comparisons. Another model than the fast path's errs less in step with it; the
  // experiment sets CIVIFOLD_VERIFY_COMPARE_MODEL.
  compare_model: process.env.CIVIFOLD_VERIFY_COMPARE_MODEL ?? "muse-spark-1.3", // a call starts only if this much is left: about the costliest single call (a crop comparison or a long turn)
};
