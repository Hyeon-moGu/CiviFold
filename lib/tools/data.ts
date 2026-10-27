// Author: HyeonMo Gu
// Created: 2026-10-27

import { haversineM } from "../geo";
import type { Category, IncidentEventType, IncidentStatus } from "./types";

export type IncidentRow = {
  id: string;
  category: Category;
  status: IncidentStatus;
  lat: number;
  lng: number;
  title: string;
  created_at: string;
  resolved_at: string | null;
  recurrence_of: string | null;
  representative_report_id: string | null;
};

export type EventRow = { incident_id: string; at: string; type: IncidentEventType; summary: string };

/** An original photo of a report linked to an incident. */
export type PhotoRow = { image_id: string; report_id: string; incident_id: string; observed_at: string };

// What the tools can read, as of `asOf`. The app reads Postgres; evaluation replays the dataset's
// incident state at each report's submit time, so tools never look at the wall clock.
export type ToolData = {
  asOf: string;
  /** May return extra rows (e.g. a bounding-box query); callers filter by exact distance. */
  incidentsNear(lat: number, lng: number, radiusM: number): Promise<IncidentRow[]>;
  incident(id: string): Promise<IncidentRow | null>;
  events(incidentId: string): Promise<EventRow[]>;
  photos(incidentIds: string[]): Promise<PhotoRow[]>;
};

export function memoryData(snapshot: {
  asOf: string;
  incidents: IncidentRow[];
  events?: EventRow[];
  photos?: PhotoRow[];
}): ToolData {
  const { asOf, incidents, events = [], photos = [] } = snapshot;
  return {
    asOf,
    incidentsNear: async (lat, lng, radiusM) => incidents.filter((r) => haversineM({ lat, lng }, r) <= radiusM),
    incident: async (id) => incidents.find((r) => r.id === id) ?? null,
    events: async (incidentId) => events.filter((e) => e.incident_id === incidentId),
    photos: async (incidentIds) => photos.filter((p) => incidentIds.includes(p.incident_id)),
  };
}
