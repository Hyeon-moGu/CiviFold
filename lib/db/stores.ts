// Author: HyeonMo Gu
// Created: 2026-10-27

// Postgres-backed versions of the stores the tools and the model cache read. Same contracts as the
// in-memory ones the evaluation uses, so the pipeline code does not know which it runs on.
import { and, between, desc, eq, inArray } from "drizzle-orm";
import type { CacheStore } from "../meta/cache";
import type { EventRow, IncidentRow, ToolData } from "../tools/data";
import type { ImageRow, ImageStore, ReportTriage, SegmentationRow } from "../tools/images";
import type { Box, Category, IncidentEventType, IncidentStatus } from "../tools/types";
import type { BlobStore } from "./blobs";
import type { Db } from "./client";
import { images, incidentEvents, incidents, llmCache, reports, segmentations } from "./schema";

const M_PER_DEG_LAT = 111_320;

function toIncident(r: typeof incidents.$inferSelect): IncidentRow {
  return {
    id: r.id,
    category: r.category as Category,
    status: r.status as IncidentStatus,
    lat: r.lat,
    lng: r.lng,
    title: r.title,
    created_at: iso(r.created_at),
    resolved_at: r.resolved_at ? iso(r.resolved_at) : null,
    recurrence_of: r.recurrence_of,
    representative_report_id: r.representative_report_id,
  };
}

// Postgres returns "2026-10-27 09:00:00+00"; the pipeline compares ISO strings.
const iso = (t: string) => new Date(t).toISOString();

/** Incident data as of `asOf` (the app passes the current time). */
export function dbData(database: Db, asOf: string): ToolData {
  return {
    asOf,
    // A bounding box over-returns at the corners; search_incidents filters by exact distance.
    incidentsNear: async (lat, lng, radiusM) => {
      const dLat = radiusM / M_PER_DEG_LAT;
      const dLng = radiusM / (M_PER_DEG_LAT * Math.cos((lat * Math.PI) / 180));
      const rows = await database
        .select()
        .from(incidents)
        .where(and(between(incidents.lat, lat - dLat, lat + dLat), between(incidents.lng, lng - dLng, lng + dLng)));
      return rows.map(toIncident);
    },
    incident: async (id) => {
      const [row] = await database.select().from(incidents).where(eq(incidents.id, id));
      return row ? toIncident(row) : null;
    },
    events: async (incidentId) => {
      const rows = await database.select().from(incidentEvents).where(eq(incidentEvents.incident_id, incidentId));
      return rows.map((e): EventRow => ({ incident_id: e.incident_id, at: iso(e.created_at), type: e.type as IncidentEventType, summary: e.summary }));
    },
    photos: async (incidentIds) => {
      if (incidentIds.length === 0) return [];
      const rows = await database
        .select({ image_id: images.id, report_id: reports.id, incident_id: reports.incident_id, observed_at: reports.observed_at })
        .from(images)
        .innerJoin(reports, eq(images.report_id, reports.id))
        .where(and(inArray(reports.incident_id, incidentIds), eq(images.kind, "original")));
      return rows.map((r) => ({ image_id: r.image_id, report_id: r.report_id, incident_id: r.incident_id!, observed_at: iso(r.observed_at) }));
    },
  };
}

export const blobKey = (imageId: string, mime: string) => `${imageId}.${mime.split("/")[1] ?? "bin"}`;

// The row without its bytes: a crop row carries hundreds of KB, and most reads only need the metadata.
const IMAGE_ROW = {
  id: images.id,
  report_id: images.report_id,
  kind: images.kind,
  source_image_id: images.source_image_id,
  width: images.width,
  height: images.height,
  mime: images.mime,
  is_synthetic: images.is_synthetic,
};

/** An image's bytes: from the row when they are stored there (crops), otherwise from the blob store (originals). */
export function storedBytes(row: { storage_path: string | null; bytes: Buffer | null }, store: BlobStore): Promise<Buffer> {
  if (row.bytes) return Promise.resolve(row.bytes);
  if (row.storage_path) return store.get(row.storage_path);
  return Promise.reject(new Error("Image has neither bytes nor a storage path"));
}

export function dbImages(database: Db, store: BlobStore): ImageStore {
  return {
    get: async (id) => {
      const [r] = await database.select(IMAGE_ROW).from(images).where(eq(images.id, id));
      if (!r) return null;
      const row: ImageRow = { ...r, kind: r.kind as ImageRow["kind"] };
      return row;
    },
    bytes: async (id) => {
      const [r] = await database.select({ storage_path: images.storage_path, bytes: images.bytes }).from(images).where(eq(images.id, id));
      if (!r) throw new Error(`Unknown image ${id}`);
      return storedBytes(r, store);
    },
    // Originals go to the blob store; crops stay in their row (see the schema).
    put: async (row, bytes) => {
      if (row.kind === "original") {
        const key = blobKey(row.id, row.mime);
        await store.put(key, bytes, row.mime);
        await database.insert(images).values({ ...row, storage_path: key, bytes: null, dataset_image_id: null }).onConflictDoNothing();
      } else {
        await database.insert(images).values({ ...row, storage_path: null, bytes, dataset_image_id: null }).onConflictDoNothing();
      }
    },
    latestSegmentation: async (imageId) => {
      const [s] = await database.select().from(segmentations).where(eq(segmentations.image_id, imageId)).orderBy(desc(segmentations.id)).limit(1);
      if (!s) return null;
      const row: SegmentationRow = {
        image_id: s.image_id,
        noun_phrase: s.noun_phrase,
        found: s.found,
        instances: s.instances,
        box: (s.box as Box | null) ?? null,
        score: s.score,
        mask_svg_path: s.mask_svg_path,
        object_crop_id: s.object_crop_id,
        context_crop_id: s.context_crop_id,
      };
      return row;
    },
    saveSegmentation: async (row) => {
      await database.insert(segmentations).values(row);
    },
    incidentOf: async (imageId) => {
      const [r] = await database
        .select({ incident_id: reports.incident_id })
        .from(images)
        .innerJoin(reports, eq(images.report_id, reports.id))
        .where(eq(images.id, imageId));
      return r?.incident_id ?? null;
    },
    triageOf: async (reportId) => {
      const [r] = await database.select({ triage: reports.triage }).from(reports).where(eq(reports.id, reportId));
      return (r?.triage as ReportTriage | null) ?? null;
    },
    saveTriage: async (reportId, triage) => {
      await database.update(reports).set({ triage }).where(eq(reports.id, reportId));
    },
  };
}

export function dbCache(database: Db): CacheStore {
  return {
    get: async (key) => {
      const [r] = await database.select().from(llmCache).where(eq(llmCache.key, key));
      return r ? { model: r.model, response: r.response, created_at: iso(r.created_at) } : null;
    },
    set: async (key, entry) => {
      await database.insert(llmCache).values({ key, model: entry.model, response: entry.response }).onConflictDoUpdate({ target: llmCache.key, set: { response: entry.response } });
    },
  };
}
