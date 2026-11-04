// Author: HyeonMo Gu
// Created: 2026-10-27

import { category, formOf, handle, isoTime, location, message, photoFrom, text, voiceFrom } from "@/lib/server/http";
import { limit } from "@/lib/server/rate-limit";
import { createReport, UserError } from "@/lib/server/reports";
import { runtime as app } from "@/lib/server/runtime";

export const runtime = "nodejs";

export async function POST(req: Request) {
  return handle(async () => {
    const rt = await app();
    await limit(rt.database, req, "report");
    const form = await formOf(req);
    // A report sent with the access code runs live.
    if (text(form, "access_code")) await limit(rt.database, req, "live");
    const [photo, voice] = await Promise.all([photoFrom(form), voiceFrom(form)]);
    const description = message(form, "description");
    if (!photo && !voice && !description) throw new UserError("Add a photo, a message or a recording.");
    // An uploaded photo's EXIF fills in what the form left out: the spot and the time it was taken.
    const meta = photo && !("sample_id" in photo) ? (photo.meta ?? null) : null;
    const typed = text(form, "lat") !== null || text(form, "lng") !== null;
    const { lat, lng } = !typed && meta?.lat != null && meta.lng != null ? { lat: meta.lat, lng: meta.lng } : location(form);
    const now = new Date().toISOString();
    const observed = text(form, "observed_at") ?? meta?.taken_at ?? null;
    const exifTime = text(form, "observed_at") ? text(form, "observed_at_source") === "exif" : Boolean(meta?.taken_at);
    return createReport(rt, {
      photo,
      voice,
      lat,
      lng,
      observed_at: isoTime(observed, now),
      observed_at_source: observed ? (exifTime ? "exif" : "user") : "assumed_submit_time",
      description,
      danger: text(form, "danger") === "yes",
      category_hint: category(form),
      access_code: text(form, "access_code"),
    });
  });
}
