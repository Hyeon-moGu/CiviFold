// Author: HyeonMo Gu
// Created: 2026-10-27

import { z } from "zod";
import { Category, ImageId, IncidentEventType, IncidentId, IncidentStatus, type Tool } from "./types";

export const GetIncidentTimelineIn = z.object({ incident_id: IncidentId }).strict();

export const GetIncidentTimelineOut = z
  .object({
    incident_id: IncidentId,
    category: Category,
    status: IncidentStatus,
    resolved_at: z.string().nullable(),
    recurrence_of: IncidentId.nullable(),
    events: z.array(z.object({ at: z.string(), type: IncidentEventType, summary: z.string() }).strict()),
    photos: z.array(z.object({ image_id: ImageId, report_id: z.string(), observed_at: z.string() }).strict()),
  })
  .strict();

export const getIncidentTimeline: Tool<typeof GetIncidentTimelineIn, typeof GetIncidentTimelineOut> = {
  name: "get_incident_timeline",
  description:
    "Get the full history of one incident: status changes, repair records, linked reports with their " +
    "observed times, and all photos. Use it to check when a repair was recorded.",
  input: GetIncidentTimelineIn,
  output: GetIncidentTimelineOut,
  run: async ({ incident_id }, { data }) => {
    const row = await data.incident(incident_id);
    if (!row) throw new Error(`Unknown incident ${incident_id}`);
    const [events, photos] = await Promise.all([data.events(incident_id), data.photos([incident_id])]);
    const byTime = <T>(time: (x: T) => string) => (a: T, b: T) => Date.parse(time(a)) - Date.parse(time(b));
    return {
      incident_id: row.id,
      category: row.category,
      status: row.status,
      resolved_at: row.resolved_at,
      recurrence_of: row.recurrence_of,
      events: events.sort(byTime((e) => e.at)).map(({ at, type, summary }) => ({ at, type, summary })),
      photos: photos
        .sort(byTime((p) => p.observed_at))
        .map(({ image_id, report_id, observed_at }) => ({ image_id, report_id, observed_at })),
    };
  },
};
