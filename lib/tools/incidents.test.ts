// Author: HyeonMo Gu
// Created: 2026-10-27

import { describe, expect, it } from "vitest";
import { haversineM, offsetM } from "../geo";
import { memoryData, type EventRow, type IncidentRow, type PhotoRow } from "./data";
import { memoryImages } from "./images";
import { GetIncidentTimelineOut, getIncidentTimeline } from "./get-incident-timeline";
import { toFunctionTool } from "./json-schema";
import { SearchIncidentsOut, searchIncidents } from "./search-incidents";
import type { ToolContext } from "./types";

const HERE = { lat: 37.5665, lng: 126.978 };
const NOW = "2026-11-01T12:00:00.000Z";

const daysAgo = (d: number) => new Date(Date.parse(NOW) - d * 86_400_000).toISOString();

/** Incident `northM` meters north of HERE, open and created 3 days ago unless overridden. */
function inc(id: string, northM: number, extra: Partial<IncidentRow> = {}): IncidentRow {
  return {
    id,
    category: "fire_hydrant",
    status: "open",
    ...offsetM(HERE, northM, 0),
    title: `Incident ${id}`,
    created_at: daysAgo(3),
    resolved_at: null,
    recurrence_of: null,
    representative_report_id: null,
    ...extra,
  };
}

function ctx(incidents: IncidentRow[], events: EventRow[] = [], photos: PhotoRow[] = []): ToolContext {
  return {
    reportId: "rep_new",
    runId: null,
    mode: "cached",
    budget: { usdLeft: 0, deadline: 0 },
    data: memoryData({ asOf: NOW, incidents, events, photos }),
    images: memoryImages(),
  };
}

const search = (c: ToolContext, over: Partial<Parameters<typeof searchIncidents.run>[0]> = {}) =>
  searchIncidents.run({ ...HERE, radius_m: 40, days_back: 90, category: null, ...over }, c);
const ids = (out: Awaited<ReturnType<typeof search>>) => out.incidents.map((i) => i.incident_id);

describe("geo", () => {
  it("measures one degree of latitude as about 111.2 km", () => {
    expect(haversineM({ lat: 0, lng: 0 }, { lat: 1, lng: 0 })).toBeCloseTo(111_195, -1);
  });

  it("offsets by meters in both directions", () => {
    expect(haversineM(HERE, offsetM(HERE, 30, 0))).toBeCloseTo(30, 1);
    expect(haversineM(HERE, offsetM(HERE, 0, -25))).toBeCloseTo(25, 1);
  });
});

describe("search_incidents", () => {
  it("returns incidents within the radius, nearest first, with rounded distances", async () => {
    const out = await search(ctx([inc("far", 39), inc("near", 5), inc("outside", 41), inc("mid", 20)]));
    expect(ids(out)).toEqual(["near", "mid", "far"]);
    expect(out.incidents[0]!.distance_m).toBe(5);
    expect(SearchIncidentsOut.safeParse(out).success).toBe(true);
  });

  it("keeps open incidents of any age and resolved ones only within days_back", async () => {
    const c = ctx([
      inc("old_open", 1, { created_at: daysAgo(400) }),
      inc("old_progress", 2, { status: "in_progress", created_at: daysAgo(400) }),
      inc("fresh_fix", 3, { status: "resolved", resolved_at: daysAgo(89) }),
      inc("stale_fix", 4, { status: "resolved", resolved_at: daysAgo(91) }),
      inc("closed_no_time", 5, { status: "closed", created_at: daysAgo(10) }),
      inc("old_closed_no_time", 6, { status: "closed", created_at: daysAgo(100) }),
    ]);
    expect(ids(await search(c))).toEqual(["old_open", "old_progress", "fresh_fix", "closed_no_time"]);
  });

  it("filters by category", async () => {
    const c = ctx([inc("hydrant", 1), inc("light", 2, { category: "streetlight" })]);
    expect(ids(await search(c, { category: "streetlight" }))).toEqual(["light"]);
  });

  it("clamps radius to 10–300 m and days_back to 1–365", async () => {
    const c = ctx([inc("at8", 8), inc("at12", 12), inc("at299", 299), inc("at301", 301)]);
    expect(ids(await search(c, { radius_m: 1 }))).toEqual(["at8"]);
    expect(ids(await search(c, { radius_m: 5000 }))).toEqual(["at8", "at12", "at299"]);
    const fixes = ctx([inc("yesterday", 1, { status: "resolved", resolved_at: daysAgo(0.5) }), inc("year", 2, { status: "resolved", resolved_at: daysAgo(364) })]);
    expect(ids(await search(fixes, { days_back: 0 }))).toEqual(["yesterday"]);
    expect(ids(await search(fixes, { days_back: 9999 }))).toEqual(["yesterday", "year"]);
  });

  it("returns at most 8 incidents, ties broken by id", async () => {
    const c = ctx(["j", "i", "h", "g", "f", "e", "d", "c", "b", "a"].map((id) => inc(id, 10)));
    expect(ids(await search(c))).toEqual(["a", "b", "c", "d", "e", "f", "g", "h"]);
  });

  it("lists the representative photo first, then the newest, up to 4", async () => {
    const photo = (image_id: string, report_id: string, d: number): PhotoRow => ({
      image_id,
      report_id,
      incident_id: "I1",
      observed_at: daysAgo(d),
    });
    const c = ctx(
      [inc("I1", 5, { representative_report_id: "r_first" })],
      [],
      [photo("img_a", "r_first", 5), photo("img_b", "r2", 4), photo("img_c", "r3", 1), photo("img_d", "r4", 3), photo("img_e", "r5", 2)],
    );
    expect((await search(c)).incidents[0]!.photo_ids).toEqual(["img_a", "img_c", "img_e", "img_d"]);
  });

  it("passes the recurrence link through", async () => {
    const c = ctx([inc("I1", 3, { status: "resolved", resolved_at: daysAgo(20) }), inc("I2", 4, { recurrence_of: "I1" })]);
    expect((await search(c)).incidents.map((i) => i.recurrence_of)).toEqual([null, "I1"]);
  });
});

describe("get_incident_timeline", () => {
  const events: EventRow[] = [
    { incident_id: "I1", at: daysAgo(1), type: "repair_recorded", summary: "Cap replaced" },
    { incident_id: "I1", at: daysAgo(3), type: "created", summary: "Created from report r1" },
    { incident_id: "I2", at: daysAgo(2), type: "created", summary: "Other incident" },
  ];
  const photos: PhotoRow[] = [
    { image_id: "img_late", report_id: "r2", incident_id: "I1", observed_at: daysAgo(2) },
    { image_id: "img_early", report_id: "r1", incident_id: "I1", observed_at: daysAgo(3) },
  ];

  it("returns the incident's events and photos in time order", async () => {
    const c = ctx([inc("I1", 0, { status: "resolved", resolved_at: daysAgo(1) }), inc("I2", 0)], events, photos);
    const out = await getIncidentTimeline.run({ incident_id: "I1" }, c);
    expect(out).toMatchObject({ incident_id: "I1", status: "resolved", resolved_at: daysAgo(1) });
    expect(out.events.map((e) => e.type)).toEqual(["created", "repair_recorded"]);
    expect(out.photos.map((p) => p.image_id)).toEqual(["img_early", "img_late"]);
    expect(GetIncidentTimelineOut.safeParse(out).success).toBe(true);
  });

  it("rejects an unknown incident", async () => {
    await expect(getIncidentTimeline.run({ incident_id: "nope" }, ctx([]))).rejects.toThrow("Unknown incident nope");
  });
});

describe("function tools", () => {
  it("converts both tools to strict function tools", () => {
    for (const tool of [searchIncidents, getIncidentTimeline]) {
      expect(toFunctionTool(tool)).toMatchObject({ type: "function", name: tool.name, strict: true });
    }
  });
});
