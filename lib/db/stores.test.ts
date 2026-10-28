// Author: HyeonMo Gu
// Created: 2026-10-27

import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { offsetM } from "../geo";
import { getIncidentTimeline } from "../tools/get-incident-timeline";
import { memoryData } from "../tools/data";
import { searchIncidents } from "../tools/search-incidents";
import type { ToolContext } from "../tools/types";
import { fileBlobs } from "./blobs";
import { openPglite, type Db } from "./client";
import { images, incidentEvents, incidents, reports } from "./schema";
import { dbCache, dbData, dbImages } from "./stores";

const HERE = { lat: 37.5665, lng: 126.978 };
const NOW = "2026-11-01T12:00:00.000Z";
let database: Db;

beforeAll(async () => {
  database = await openPglite(null);
  const near = offsetM(HERE, 10, 0);
  const far = offsetM(HERE, 200, 0);
  await database.insert(incidents).values([
    { id: "I1", category: "trash", status: "open", ...near, title: "Bags by the wall", created_at: "2026-10-30T09:00:00.000Z", representative_report_id: "r1" },
    { id: "I2", category: "trash", status: "open", ...far, title: "Far away", created_at: "2026-10-30T09:00:00.000Z" },
  ]);
  await database.insert(reports).values([
    { id: "r1", tracking_code: "CF-AAAA", incident_id: "I1", ...near, observed_at: "2026-10-30T08:00:00.000Z", observed_at_source: "user", submitted_at: "2026-10-30T09:00:00.000Z", status: "linked", is_synthetic: true },
    { id: "r2", tracking_code: "CF-BBBB", incident_id: "I1", ...near, observed_at: "2026-10-31T08:00:00.000Z", observed_at_source: "user", submitted_at: "2026-10-31T09:00:00.000Z", status: "linked", is_synthetic: true },
  ]);
  const img = (id: string, report_id: string, kind = "original") => ({ id, report_id, kind, storage_path: `${id}.webp`, mime: "image/webp", width: 10, height: 10, is_synthetic: true });
  await database.insert(images).values([img("img_1", "r1"), img("img_2", "r2"), img("img_2_crop", "r2", "object_crop")]);
  await database.insert(incidentEvents).values([
    { incident_id: "I1", type: "report_linked", actor: "system", summary: "r2 linked", created_at: "2026-10-31T09:00:00.000Z" },
    { incident_id: "I1", type: "created", actor: "system", summary: "From r1", created_at: "2026-10-30T09:00:00.000Z" },
  ]);
}, 60_000);

function ctx(): ToolContext {
  return {
    reportId: "r_new",
    runId: null,
    mode: "cached",
    budget: { usdLeft: 0, deadline: 0 },
    data: dbData(database, NOW),
    images: dbImages(database, fileBlobs()),
  };
}

describe("dbData", () => {
  it("finds incidents by distance through the bounding box", async () => {
    const out = await searchIncidents.run({ ...HERE, radius_m: 40, days_back: 90, category: null }, ctx());
    expect(out.incidents.map((i) => [i.incident_id, i.distance_m])).toEqual([["I1", 10]]);
    expect(out.incidents[0]!.photo_ids).toEqual(["img_1", "img_2"]);
  });

  it("returns the timeline with original photos only, in time order", async () => {
    const out = await getIncidentTimeline.run({ incident_id: "I1" }, ctx());
    expect(out.events.map((e) => e.type)).toEqual(["created", "report_linked"]);
    expect(out.photos.map((p) => p.image_id)).toEqual(["img_1", "img_2"]);
    expect(out.photos[0]!.observed_at).toBe("2026-10-30T08:00:00.000Z");
  });

  it("matches the in-memory store on the same rows", async () => {
    const fromDb = await dbData(database, NOW).incident("I1");
    const mem = memoryData({ asOf: NOW, incidents: [fromDb!] });
    expect(await mem.incident("I1")).toEqual(fromDb);
  });
});

describe("dbImages", () => {
  it("stores bytes and rows, resolves the incident, and keeps triage and segmentations", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "civifold-blobs-"));
    const store = dbImages(database, fileBlobs(dir));
    await database.insert(reports).values({ id: "r3", tracking_code: "CF-CCCC", ...HERE, observed_at: NOW, observed_at_source: "user", submitted_at: NOW, status: "received", is_synthetic: false });
    await store.put({ id: "img_3", report_id: "r3", kind: "original", source_image_id: null, width: 2, height: 1, mime: "image/png", is_synthetic: false }, Buffer.from("png"));
    expect((await store.bytes("img_3")).toString()).toBe("png");
    expect(await store.get("img_3")).toMatchObject({ report_id: "r3", width: 2, mime: "image/png" });
    expect(await store.incidentOf("img_2")).toBe("I1");
    expect(await store.incidentOf("img_3")).toBeNull();

    expect(await store.triageOf("r3")).toBeNull();
    await store.saveTriage("r3", { category: "trash", sam_prompt: "trash" });
    expect(await store.triageOf("r3")).toEqual({ category: "trash", sam_prompt: "trash" });

    const seg = { image_id: "img_3", noun_phrase: "trash", found: false, instances: 0, box: null, score: null, mask_svg_path: null, object_crop_id: null, context_crop_id: null };
    await store.saveSegmentation(seg);
    await store.saveSegmentation({ ...seg, noun_phrase: "garbage bags" });
    expect((await store.latestSegmentation("img_3"))?.noun_phrase).toBe("garbage bags");
  });
});

describe("dbCache", () => {
  it("stores and replaces responses by key", async () => {
    const cache = dbCache(database);
    expect(await cache.get("k")).toBeNull();
    await cache.set("k", { model: "m", response: { a: 1 }, created_at: NOW });
    await cache.set("k", { model: "m", response: { a: 2 }, created_at: NOW });
    expect((await cache.get("k"))?.response).toEqual({ a: 2 });
  });
});
