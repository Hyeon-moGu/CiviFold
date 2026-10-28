// Author: HyeonMo Gu
// Created: 2026-10-27

import { createHash } from "node:crypto";
import { imageId, type Asset, type AssetFile, type State, type View } from "../dataset/assets";
import { offsetM, type LatLng } from "../geo";
import type { Category, Label } from "../tools/types";

// Every main asset follows the same timeline from T0; assets sit at least 100 m apart, so their
// incidents never become each other's candidates (look-alikes, 25–30 m from their pair, do on purpose).
export const T0 = "2026-09-01T09:00:00.000Z";
const DAY_MS = 86_400_000;
export const at = (days: number) => new Date(Date.parse(T0) + days * DAY_MS).toISOString();

export const REPAIR_DAY = 3;
export const RECURRENCE_DAY = 20;

/** The incident a report belongs to, as `${assetId}/I1` (first problem) or `${assetId}/I2` (recurrence). */
export const incidentKey = (assetId: string, n: 1 | 2) => `${assetId}/I${n}`;

// How a resident's camera can spoil a photo; applied to the report photo at evaluation time.
export const TRANSFORMS = ["blur", "low_res", "jpeg", "off_center", "dark"] as const;
export type Transform = (typeof TRANSFORMS)[number];

export type Case = {
  id: string;
  asset_id: string;
  split: Asset["split"];
  // base: the designed timeline. stress: the same reports at night or with a degraded photo.
  set: "base" | "stress";
  kind: string;
  image_id: string;
  transform: Transform | null;
  submitted_at: string;
  observed_at: string; // what the report says
  true_observed_at: string; // what the simulated resident answers when asked
  location: LatLng;
  category_hint: Category;
  expected: { label: Label; incident: string | null };
  answers: { wider_context: string; close_up: string };
};

// The main-asset timeline. Reports that the oracle links to an incident become that incident's photos.
export const TIMELINE: Array<{
  n: number;
  state: State;
  view: View;
  submitted: number;
  observed: number;
  expected: Label;
  incident: 1 | 2 | null;
  links_to: 1 | 2 | null;
}> = [
  { n: 1, state: "damaged_v1", view: "front", submitted: 0, observed: 0, expected: "NEW", incident: null, links_to: 1 },
  { n: 2, state: "damaged_v1", view: "across", submitted: 1, observed: 1, expected: "DUPLICATE", incident: 1, links_to: 1 },
  { n: 3, state: "damaged_v1", view: "closeup", submitted: 2, observed: 2, expected: "DUPLICATE", incident: 1, links_to: 1 },
  { n: 4, state: "damaged_v1", view: "sidewalk", submitted: 4, observed: 2, expected: "LATE_REPORT", incident: 1, links_to: 1 },
  { n: 5, state: "repaired", view: "across", submitted: 5, observed: 5, expected: "ALREADY_RESOLVED", incident: 1, links_to: null },
  { n: 6, state: "damaged_v2", view: "front", submitted: 20, observed: 20, expected: "POSSIBLE_RECURRENCE", incident: 1, links_to: 2 },
  { n: 7, state: "damaged_v2", view: "sidewalk", submitted: 21, observed: 21, expected: "DUPLICATE", incident: 2, links_to: 2 },
];

const GPS_NOISE_M = 15; // every report: up to this far off, in a random direction
const GPS_SMALL_M = 25;
const GPS_LARGE_M = 80;

/** A fixed pseudo-random number in [0, 1) per key, so cases.json is the same on every build. */
function unit(key: string): number {
  return createHash("sha256").update(key).digest().readUInt32BE(0) / 2 ** 32;
}

function jitter(origin: LatLng, key: string, distanceM: number): LatLng {
  const angle = unit(`${key}:angle`) * 2 * Math.PI;
  return offsetM(origin, distanceM * Math.cos(angle), distanceM * Math.sin(angle));
}

export function assetLocation(file: AssetFile, a: Asset): LatLng {
  return offsetM(file.base, a.offset_m.dy, a.offset_m.dx);
}

// The views a resident could send when asked, in order of preference: day views first, night as a last resort.
const WIDE: Record<State, View[]> = {
  damaged_v1: ["front", "across", "sidewalk", "across_night"],
  repaired: ["front", "across"],
  damaged_v2: ["front", "sidewalk", "front_night"],
};
const CLOSE: Record<State, View[]> = {
  damaged_v1: ["closeup", "closeup_side"],
  repaired: ["front", "across"],
  damaged_v2: ["closeup", "front", "sidewalk"],
};

// Photos the oracle world already holds for this asset when a report arrives (worldAt links the same steps).
function heldBefore(a: Asset, submittedDay: number): Set<string> {
  if (a.role === "lookalike") return new Set();
  return new Set(TIMELINE.filter((s) => s.links_to && s.submitted < submittedDay).map((s) => imageId(a.id, s.state, s.view)));
}

// What the simulated resident sends when asked: a photo that is neither the one they reported nor one the incident
// already holds, so the answer is an independent observation and a match cannot come from comparing a photo with itself.
function answers(a: Asset, state: State, view: View, submittedDay: number): Case["answers"] {
  const used = heldBefore(a, submittedDay).add(imageId(a.id, state, view));
  const pick = (views: View[], item: string) => {
    const id = views.map((v) => imageId(a.id, state, v)).find((x) => !used.has(x));
    if (!id) throw new Error(`${a.id} ${state} ${view}: no independent ${item} photo`);
    return id;
  };
  if (a.role === "lookalike") return { wider_context: pick(["front", "across"], "wide"), close_up: pick(["front", "across"], "close-up") };
  return { wider_context: pick(WIDE[state], "wide"), close_up: pick(CLOSE[state], "close-up") };
}

type Timing = { submitted: number; observed: number; true_observed?: number };
type Extra = { gpsErrorM?: number; set?: Case["set"]; transform?: Transform | null };

export function buildCases(file: AssetFile): Case[] {
  const cases: Case[] = [];
  const add = (a: Asset, kind: string, state: State, view: View, t: Timing, expected: Case["expected"], extra: Extra = {}) => {
    const id = `${a.id}-${kind}`;
    const reply = answers(a, state, view, t.submitted);
    cases.push({
      id,
      asset_id: a.id,
      split: a.split,
      set: extra.set ?? "base",
      kind,
      image_id: imageId(a.id, state, view),
      transform: extra.transform ?? null,
      submitted_at: at(t.submitted),
      observed_at: at(t.observed),
      true_observed_at: at(t.true_observed ?? t.observed),
      location: jitter(assetLocation(file, a), id, extra.gpsErrorM ?? unit(`${id}:distance`) * GPS_NOISE_M),
      category_hint: a.category,
      expected,
      answers: reply,
    });
  };
  let mainIndex = 0;

  for (const a of file.assets) {
    if (a.role === "lookalike") {
      // Probes against the pair's timeline: never part of the replayed world.
      add(a, "lookalike-open", "damaged_v1", "front", { submitted: 1.1, observed: 1.1 }, { label: "NEW", incident: null });
      add(a, "lookalike-after-fix", "damaged_v1", "across", { submitted: 6, observed: 6 }, { label: "NEW", incident: null });
      continue;
    }
    for (const step of TIMELINE) {
      const incident = step.incident ? incidentKey(a.id, step.incident) : null;
      add(a, `t${step.n}`, step.state, step.view, step, { label: step.expected, incident });
    }
    const late = { label: "LATE_REPORT" as const, incident: incidentKey(a.id, 1) };
    if (a.special_cases.includes("time_conflict")) {
      add(a, "time-conflict", "damaged_v1", "across", { submitted: REPAIR_DAY + 1, observed: REPAIR_DAY + 1, true_observed: 2 }, late);
    }
    if (a.special_cases.includes("gps_small")) {
      add(a, "gps-small", "damaged_v1", "across", { submitted: 1, observed: 1 }, { label: "DUPLICATE", incident: incidentKey(a.id, 1) }, { gpsErrorM: GPS_SMALL_M });
    }
    if (a.special_cases.includes("gps_large")) {
      add(a, "gps-large-t2", "damaged_v1", "across", { submitted: 1, observed: 1 }, { label: "DUPLICATE", incident: incidentKey(a.id, 1) }, { gpsErrorM: GPS_LARGE_M });
      add(a, "gps-large-t6", "damaged_v2", "front", { submitted: 20, observed: 20 }, { label: "POSSIBLE_RECURRENCE", incident: incidentKey(a.id, 1) }, { gpsErrorM: GPS_LARGE_M });
    }
    if (a.special_cases.includes("closeup_late")) {
      add(a, "closeup-late", "damaged_v1", "closeup", { submitted: REPAIR_DAY + 2, observed: REPAIR_DAY - 1 }, late);
    }

    // Stress set: timeline reports 2 (a duplicate) and 6 (a recurrence) at night and with a degraded photo.
    const t2 = TIMELINE[1]!;
    const t6 = TIMELINE[5]!;
    const expect = (s: typeof t2) => ({ label: s.expected, incident: s.incident ? incidentKey(a.id, s.incident) : null });
    add(a, "t2-night", "damaged_v1", "across_night", t2, expect(t2), { set: "stress" });
    add(a, "t6-night", "damaged_v2", "front_night", t6, expect(t6), { set: "stress" });
    const [first, second] = [TRANSFORMS[(2 * mainIndex) % TRANSFORMS.length]!, TRANSFORMS[(2 * mainIndex + 1) % TRANSFORMS.length]!];
    add(a, `t2-${first}`, t2.state, t2.view, t2, expect(t2), { set: "stress", transform: first });
    add(a, `t6-${second}`, t6.state, t6.view, t6, expect(t6), { set: "stress", transform: second });
    mainIndex += 1;
  }
  return cases;
}
