// Author: HyeonMo Gu
// Created: 2026-10-27

import { z } from "zod";
import { haversineM } from "../geo";
import type { IncidentRow, PhotoRow } from "./data";
import { Category, ImageId, IncidentId, IncidentStatus, type Tool } from "./types";

const MAX_RESULTS = 8;
const MAX_PHOTOS = 4;
const DAY_MS = 86_400_000;

export const SearchIncidentsIn = z
  .object({
    lat: z.number(),
    lng: z.number(),
    radius_m: z.number().describe("10–300. Default pipeline radius is 30–40 m"),
    days_back: z.number().describe("1–365. How far back to include resolved incidents"),
    category: Category.nullable().describe("Filter by category, or null for all"),
  })
  .strict();

export const SearchIncidentsOut = z
  .object({
    incidents: z.array(
      z
        .object({
          incident_id: IncidentId,
          category: Category,
          status: IncidentStatus,
          title: z.string(),
          distance_m: z.number(),
          created_at: z.string(),
          resolved_at: z.string().nullable(),
          recurrence_of: IncidentId.nullable(),
          photo_ids: z.array(ImageId).describe("Up to 4 representative photos"),
        })
        .strict(),
    ),
  })
  .strict();

export const searchIncidents: Tool<typeof SearchIncidentsIn, typeof SearchIncidentsOut> = {
  name: "search_incidents",
  description:
    "Find existing incidents near a location. Returns open/in-progress incidents and incidents " +
    "resolved within days_back, sorted by distance. Use a larger radius when the report's GPS may be off.",
  input: SearchIncidentsIn,
  output: SearchIncidentsOut,
  run: async (input, { data }) => {
    const radiusM = clamp(input.radius_m, 10, 300);
    const cutoffMs = Date.parse(data.asOf) - clamp(input.days_back, 1, 365) * DAY_MS;
    const rows = await data.incidentsNear(input.lat, input.lng, radiusM);
    const hits = rows
      .map((row) => ({ row, distanceM: haversineM(input, row) }))
      .filter(({ row, distanceM }) => distanceM <= radiusM && (input.category === null || row.category === input.category))
      .filter(({ row }) => isActiveOrRecent(row, cutoffMs))
      .sort((a, b) => a.distanceM - b.distanceM || a.row.id.localeCompare(b.row.id))
      .slice(0, MAX_RESULTS);
    const photos = await data.photos(hits.map((h) => h.row.id));
    return {
      incidents: hits.map(({ row, distanceM }) => ({
        incident_id: row.id,
        category: row.category,
        status: row.status,
        title: row.title,
        distance_m: Math.round(distanceM * 10) / 10,
        created_at: row.created_at,
        resolved_at: row.resolved_at,
        recurrence_of: row.recurrence_of,
        photo_ids: representativePhotos(row, photos),
      })),
    };
  },
};

// A repaired incident without a repair time is aged by its creation time.
function isActiveOrRecent(row: IncidentRow, cutoffMs: number): boolean {
  if (row.status === "open" || row.status === "in_progress") return true;
  return Date.parse(row.resolved_at ?? row.created_at) >= cutoffMs;
}

// The representative report's photo first, then the most recently observed ones.
function representativePhotos(row: IncidentRow, photos: PhotoRow[]): string[] {
  return photos
    .filter((p) => p.incident_id === row.id)
    .sort(
      (a, b) =>
        Number(b.report_id === row.representative_report_id) - Number(a.report_id === row.representative_report_id) ||
        Date.parse(b.observed_at) - Date.parse(a.observed_at) ||
        a.image_id.localeCompare(b.image_id),
    )
    .slice(0, MAX_PHOTOS)
    .map((p) => p.image_id);
}

function clamp(x: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, x));
}
