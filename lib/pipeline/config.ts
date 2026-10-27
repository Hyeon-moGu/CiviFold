// Author: HyeonMo Gu
// Created: 2026-10-27

// Every threshold lives here. Tune against the dev split only.
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
