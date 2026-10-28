// Author: HyeonMo Gu
// Created: 2026-10-27

import sharp from "sharp";
import { checkWav } from "../meta/voice";
import { photoMeta } from "./photo-meta";
import { Category } from "../tools/types";
import { UserError, type Photo, type Voice } from "./reports";

/** JSON response for a route; a UserError becomes a 400 with its message, anything else a 500. */
export async function handle(fn: () => Promise<unknown>): Promise<Response> {
  try {
    return Response.json(await fn());
  } catch (err) {
    if (err instanceof UserError) return Response.json({ error: err.message, ...(err.code ? { code: err.code } : {}) }, { status: err.code === "stale" ? 409 : 400 });
    console.error(err);
    return Response.json({ error: "Something went wrong on our side." }, { status: 500 });
  }
}

const MAX_UPLOAD = 25 * 1024 * 1024; // a 50 MP phone photo; the browser shrinks large ones before a deployment's 4.5 MB body limit
const ACCEPTED = new Set(["image/jpeg", "image/png", "image/webp"]);
const MAX_SIDE = 1920; // what the models are given anyway; also what the dataset photos are

/**
 * The photo in a form: a sample id, or an uploaded file. An upload's EXIF (where and when it was taken) is read
 * first; the photo is then turned upright, scaled down and re-encoded, which also drops the EXIF, GPS included.
 */
export async function photoFrom(form: FormData): Promise<Photo | null> {
  const sampleId = form.get("sample_id");
  if (typeof sampleId === "string" && sampleId) return { sample_id: sampleId };
  const file = form.get("photo");
  if (!(file instanceof File) || file.size === 0) return null;
  if (file.size > MAX_UPLOAD) throw new UserError("Photos up to 25 MB, please.");
  if (!ACCEPTED.has(file.type)) throw new UserError("Please upload a JPEG, PNG or WebP photo.");
  const original = Buffer.from(await file.arrayBuffer());
  const offset = Number(text(form, "tz_offset"));
  const meta = await photoMeta(original, Number.isFinite(offset) ? offset : null);
  const normalized = await sharp(original)
    .rotate()
    .resize({ width: MAX_SIDE, height: MAX_SIDE, fit: "inside", withoutEnlargement: true })
    .jpeg({ quality: 88 })
    .toBuffer({ resolveWithObject: true })
    .catch(() => null);
  if (!normalized) throw new UserError("That file does not look like a photo.");
  return { bytes: normalized.data, mime: "image/jpeg", width: normalized.info.width, height: normalized.info.height, meta };
}

const MAX_RECORDING_MS = 60_000;

/** The recording in a form: a sample message id, or a WAV the browser encoded (see app/_ui/wav.ts). */
export async function voiceFrom(form: FormData): Promise<Voice | null> {
  const sampleId = form.get("voice_sample_id");
  if (typeof sampleId === "string" && sampleId) return { sample_id: sampleId };
  const file = form.get("voice");
  if (!(file instanceof File) || file.size === 0) return null;
  if (file.size > 4 * 1024 * 1024) throw new UserError("Recordings up to one minute, please.");
  const bytes = Buffer.from(await file.arrayBuffer());
  const info = checkWav(bytes);
  if (typeof info === "string") throw new UserError(`That recording could not be read (${info}).`);
  if (info.durationMs > MAX_RECORDING_MS) throw new UserError("Recordings up to one minute, please.");
  if (info.durationMs < 500) throw new UserError("That recording is too short.");
  return { bytes };
}

export function text(form: FormData, key: string): string | null {
  const v = form.get(key);
  return typeof v === "string" && v.trim() ? v.trim() : null;
}

/** Latitude and longitude from a form; a missing field is an error, not 0 (Number(null) is 0). */
export function location(form: FormData): { lat: number; lng: number } {
  const [lat, lng] = [text(form, "lat"), text(form, "lng")].map((v) => (v === null ? NaN : Number(v))) as [number, number];
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) throw new UserError("Set the location of the problem.");
  if (Math.abs(lat) > 90 || Math.abs(lng) > 180) throw new UserError("That location is not on the map.");
  return { lat, lng };
}

export function category(form: FormData): Category | null {
  const parsed = Category.safeParse(text(form, "category_hint"));
  return parsed.success ? parsed.data : null;
}

export function isoTime(value: string | null, fallback: string): string {
  if (!value) return fallback;
  const t = Date.parse(value);
  if (Number.isNaN(t)) throw new UserError("That time could not be read.");
  if (t > Date.now() + 5 * 60_000) throw new UserError("The time a photo was taken cannot be in the future.");
  return new Date(t).toISOString();
}
