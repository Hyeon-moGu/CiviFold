// Author: HyeonMo Gu
// Created: 2026-10-27

// The demo world: every main dataset asset has one open incident, created a few days ago from its
// first report (the front photo). Everything else in the dataset is left for residents to submit. Beside them,
// the real San Francisco 311 pairs (lib/dataset/real.ts): each earlier request is an incident at its own place
// and time, resolved when Public Works closed it for a pair made after the cleanup.
// seedDemo only writes the database, so /api/demo/reset can run it on a deployment; uploadDataset
// puts the photos in the blob store once, from a machine that has dataset/images.
import { readdir, readFile } from "node:fs/promises";
import { desc, sql } from "drizzle-orm";
import { imageId, type AssetFile } from "../dataset/assets";
import { REAL_PAIRS, realFile } from "../dataset/real";
import { VOICE_DIR, voiceBlobKey } from "../dataset/messages";
import type { BlobStore } from "../db/blobs";
import type { Db } from "../db/client";
import { demoResets, images, incidentEvents, incidents, reports } from "../db/schema";
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
  "briefs",
  "info_requests",
  "staff_decisions",
] as const;

const DAY_MS = 86_400_000;

export const RESET_COOLDOWN_MS = 60_000;

/**
 * Records a public reset, unless one happened within the cooldown: then it returns the seconds to wait
 * (0 when the reset may go ahead). The check and the record run under one table lock, so two visitors
 * clicking at once cannot both reset.
 */
export async function claimReset(database: Db, now = new Date(), cooldownMs = RESET_COOLDOWN_MS): Promise<number> {
  return database.transaction(async (tx) => {
    await tx.execute(sql`LOCK TABLE demo_resets IN SHARE ROW EXCLUSIVE MODE`);
    const [last] = await tx.select({ at: demoResets.created_at }).from(demoResets).orderBy(desc(demoResets.id)).limit(1);
    const wait = last ? new Date(last.at).getTime() + cooldownMs - now.getTime() : 0;
    if (wait > 0) return Math.ceil(wait / 1000);
    await tx.insert(demoResets).values({ created_at: now.toISOString() });
    return 0;
  });
}

export const seedIncidentId = (assetId: string) => `inc_${assetId.toLowerCase()}`;
export const seedReportId = (assetId: string) => `rep_${assetId.toLowerCase()}_1`;

// The uploads run from a machine with the dataset; the ignores stop the bundler from tracing it into the app.
/** Uploads every dataset photo the blob store does not have yet. */
export async function uploadDataset(store: BlobStore, dir = "dataset/images"): Promise<number> {
  let uploaded = 0;
  for (const name of (await readdir(/*turbopackIgnore: true*/ dir)).filter((f) => f.endsWith(".webp"))) {
    if (await store.has(name)) continue;
    await store.put(name, await readFile(/*turbopackIgnore: true*/ `${dir}/${name}`), "image/webp");
    uploaded += 1;
  }
  return uploaded;
}

/** Uploads the real San Francisco 311 photos the blob store does not have yet. */
export async function uploadReal(store: BlobStore): Promise<number> {
  let uploaded = 0;
  for (const photo of REAL_PAIRS.flatMap((p) => [p.earlier, p.later])) {
    const key = blobKey(photo.id, "image/jpeg");
    if (await store.has(key)) continue;
    await store.put(key, await readFile(/*turbopackIgnore: true*/ realFile(photo.id)), "image/jpeg");
    uploaded += 1;
  }
  return uploaded;
}

/** Uploads the sample voice messages the blob store does not have yet. */
export async function uploadVoices(store: BlobStore, dir = VOICE_DIR): Promise<number> {
  let uploaded = 0;
  for (const name of (await readdir(/*turbopackIgnore: true*/ dir)).filter((f) => f.endsWith(".wav"))) {
    const key = voiceBlobKey(name.replace(/\.wav$/, ""));
    if (await store.has(key)) continue;
    await store.put(key, await readFile(/*turbopackIgnore: true*/ `${dir}/${name}`), "audio/wav");
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
  for (const p of REAL_PAIRS) {
    const incident = seedIncidentId(p.id);
    const report = seedReportId(p.id);
    const at = p.earlier.observed_at;
    const loc = { lat: p.earlier.lat, lng: p.earlier.lng };
    await database.insert(incidents).values({
      id: incident,
      category: p.category,
      status: p.resolved_at ? "resolved" : "open",
      ...loc,
      title: p.title,
      created_at: at,
      resolved_at: p.resolved_at,
      representative_report_id: report,
    });
    await database.insert(reports).values({
      id: report,
      tracking_code: `CF-${p.id}A`,
      incident_id: incident,
      ...loc,
      observed_at: at,
      observed_at_source: "user",
      submitted_at: at,
      status: "new_incident",
      triage: { category: p.category, sam_prompt: p.sam_prompt },
      is_synthetic: false,
      dataset_case_id: `sf311-${p.pair}-1`,
    });
    await database.insert(images).values({
      id: p.earlier.id,
      report_id: report,
      kind: "original",
      storage_path: blobKey(p.earlier.id, "image/jpeg"),
      mime: "image/jpeg",
      width: p.earlier.width,
      height: p.earlier.height,
      is_synthetic: false,
      dataset_image_id: p.earlier.id,
    });
    await database.insert(incidentEvents).values({ incident_id: incident, type: "created", actor: "system", summary: `Opened from San Francisco 311 request ${p.earlier.case}`, created_at: at });
    if (p.resolved_at) {
      await database.insert(incidentEvents).values({ incident_id: incident, type: "repair_recorded", actor: "staff", summary: "Public Works closed the request as resolved", created_at: p.resolved_at });
    }
  }
  return { incidents: mains.length + REAL_PAIRS.length };
}
