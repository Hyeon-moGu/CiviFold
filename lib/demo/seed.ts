// Author: HyeonMo Gu
// Created: 2026-10-27

// The demo world: every main dataset asset has one open incident, created a few days ago from its
// first report (the front photo). Everything else in the dataset is left for residents to submit.
// seedDemo only writes the database, so /api/demo/reset can run it on a deployment; uploadDataset
// puts the photos in the blob store once, from a machine that has dataset/images.
import { readdir, readFile } from "node:fs/promises";
import { sql } from "drizzle-orm";
import { imageId, type AssetFile } from "../dataset/assets";
import { VOICE_DIR, voiceBlobKey } from "../dataset/messages";
import type { BlobStore } from "../db/blobs";
import type { Db } from "../db/client";
import { images, incidentEvents, incidents, reports } from "../db/schema";
import { blobKey } from "../db/stores";
import { assetLocation } from "../eval/cases";

const TABLES = [
  "incidents",
  "incident_events",
  "reports",
  "images",
  "segmentations",
  "report_analyses",
  "agent_runs",
  "info_requests",
  "staff_decisions",
] as const;

const DAY_MS = 86_400_000;

export const seedIncidentId = (assetId: string) => `inc_${assetId.toLowerCase()}`;
export const seedReportId = (assetId: string) => `rep_${assetId.toLowerCase()}_1`;

/** Uploads every dataset photo the blob store does not have yet. */
export async function uploadDataset(store: BlobStore, dir = "dataset/images"): Promise<number> {
  let uploaded = 0;
  for (const name of (await readdir(dir)).filter((f) => f.endsWith(".webp"))) {
    if (await store.has(name)) continue;
    await store.put(name, await readFile(`${dir}/${name}`), "image/webp");
    uploaded += 1;
  }
  return uploaded;
}

/** Uploads the sample voice messages the blob store does not have yet. */
export async function uploadVoices(store: BlobStore, dir = VOICE_DIR): Promise<number> {
  let uploaded = 0;
  for (const name of (await readdir(dir)).filter((f) => f.endsWith(".wav"))) {
    const key = voiceBlobKey(name.replace(/\.wav$/, ""));
    if (await store.has(key)) continue;
    await store.put(key, await readFile(`${dir}/${name}`), "audio/wav");
    uploaded += 1;
  }
  return uploaded;
}

/** Empties the demo tables (the model cache and spend log stay) and seeds the world as of `now`. */
export async function seedDemo(database: Db, file: AssetFile, now = new Date()): Promise<{ incidents: number }> {
  await database.execute(sql.raw(`TRUNCATE ${TABLES.join(", ")} RESTART IDENTITY`));
  const created = new Date(now.getTime() - 3 * DAY_MS).toISOString();
  const observed = new Date(now.getTime() - 3 * DAY_MS - 3_600_000).toISOString();

  const mains = file.assets.filter((a) => a.role === "main");
  for (const a of mains) {
    const photo = imageId(a.id, "damaged_v1", "front");
    const key = blobKey(photo, "image/webp");
    const loc = assetLocation(file, a);
    const incident = seedIncidentId(a.id);
    const report = seedReportId(a.id);
    await database.insert(incidents).values({ id: incident, category: a.category, status: "open", ...loc, title: a.object, created_at: created, representative_report_id: report });
    await database.insert(reports).values({
      id: report,
      tracking_code: `CF-${a.id}A`,
      incident_id: incident,
      ...loc,
      observed_at: observed,
      observed_at_source: "user",
      submitted_at: created,
      status: "new_incident",
      triage: { category: a.category, sam_prompt: a.sam_prompt },
      is_synthetic: true,
      dataset_case_id: `${a.id}-t1`,
    });
    await database.insert(images).values({
      id: photo,
      report_id: report,
      kind: "original",
      storage_path: key,
      mime: "image/webp",
      width: 1920,
      height: 1280,
      is_synthetic: true,
      dataset_image_id: photo,
    });
    await database.insert(incidentEvents).values({ incident_id: incident, type: "created", actor: "system", summary: "Opened from the first resident report", created_at: created });
  }
  return { incidents: mains.length };
}
