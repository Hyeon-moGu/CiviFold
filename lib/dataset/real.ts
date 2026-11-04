// Author: HyeonMo Gu
// Created: 2026-11-04

// Real photos from San Francisco 311 (DataSF 311 Cases, PDDL 1.0) for the demo: four pairs of requests at one spot,
// picked by eye from eval/sf311/pairs.json. Each pair keeps its own place, times and case numbers. The photos in
// dataset/real-sf/ are the published ones, normalized like an upload, with people and license plates blurred.
import type { Category } from "../tools/types";

type Photo = { id: string; case: string; observed_at: string; lat: number; lng: number; width: number; height: number };

export type RealPair = {
  id: string; // the seeded incident's asset-like id: inc_<id>, rep_<id>_1
  pair: string; // its pair in eval/sf311/pairs.json
  category: Category;
  sam_prompt: string;
  title: string;
  // What the later photo shows, when it is not what the request on file showed (new trash after a cleanup).
  later_title?: string;
  earlier: Photo; // the request on file: the seeded incident's photo
  later: Photo; // the request the demo sends
  // When Public Works closed the earlier request as resolved, for a pair made after the cleanup.
  resolved_at: string | null;
};

export const REAL_PAIRS: RealPair[] = [
  {
    id: "SF058",
    pair: "t058",
    category: "trash",
    sam_prompt: "trash",
    title: "wooden panel dumped at a street tree on 24th Street",
    earlier: { id: "sf_t058_1", case: "202000065099", observed_at: "2026-09-14T16:28:11.000Z", lat: 37.751566, lng: -122.428001, width: 864, height: 1152 },
    later: { id: "sf_t058_2", case: "202000068943", observed_at: "2026-09-15T16:24:14.000Z", lat: 37.751603, lng: -122.428049, width: 864, height: 1152 },
    resolved_at: null,
  },
  {
    id: "SF123",
    pair: "a123",
    category: "trash",
    sam_prompt: "trash",
    title: "cardboard and plastic at the corner tree on Alemany Boulevard",
    later_title: "trash at the corner tree on Alemany Boulevard",
    earlier: { id: "sf_a123_1", case: "202000046581", observed_at: "2026-09-09T13:55:58.000Z", lat: 37.715791, lng: -122.444534, width: 864, height: 1152 },
    later: { id: "sf_a123_2", case: "202000068065", observed_at: "2026-09-15T13:42:12.000Z", lat: 37.715788, lng: -122.444566, width: 864, height: 1152 },
    resolved_at: "2026-09-09T15:45:44.000Z",
  },
  {
    id: "SF052",
    pair: "t052",
    category: "trash",
    sam_prompt: "trash",
    title: "orange bags at the balustrade on Highland Avenue",
    earlier: { id: "sf_t052_1", case: "202000063217", observed_at: "2026-09-13T23:59:27.000Z", lat: 37.737478, lng: -122.424863, width: 864, height: 1152 },
    later: { id: "sf_t052_2", case: "202000065126", observed_at: "2026-09-14T16:32:52.000Z", lat: 37.737488, lng: -122.424857, width: 1152, height: 864 },
    resolved_at: null,
  },
  {
    id: "SF085",
    pair: "r085",
    category: "road_damage",
    sam_prompt: "pothole",
    title: "broken utility cover in the sidewalk on Pacific Avenue",
    earlier: { id: "sf_r085_1", case: "202000212553", observed_at: "2026-10-23T08:36:25.000Z", lat: 37.795087, lng: -122.420892, width: 864, height: 1152 },
    later: { id: "sf_r085_2", case: "202000222488", observed_at: "2026-10-25T19:49:28.000Z", lat: 37.795082, lng: -122.420869, width: 648, height: 1152 },
    resolved_at: null,
  },
];

export const REAL_CREDIT = "San Francisco 311 public records (DataSF, PDDL 1.0), people and license plates blurred";

/** The file a real photo is published from, by its image id ("sf_t058_2" → dataset/real-sf/t058_2.jpg). */
export const realFile = (imageId: string) => `dataset/real-sf/${imageId.replace(/^sf_/, "")}.jpg`;

export type RealSample = RealPair["later"] & { pair: RealPair };

/** A real photo the demo sends as a report: the later request of a pair. */
export function realSample(id: string): RealSample | null {
  const pair = REAL_PAIRS.find((p) => p.later.id === id);
  return pair ? { ...pair.later, pair } : null;
}

/** Any published real photo, earlier or later, by its image id. */
export function realPhoto(id: string): RealPair["earlier"] | null {
  for (const p of REAL_PAIRS) {
    if (p.earlier.id === id) return p.earlier;
    if (p.later.id === id) return p.later;
  }
  return null;
}
