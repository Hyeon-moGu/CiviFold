// Author: HyeonMo Gu
// Created: 2026-10-27

import { category, handle, isoTime, location, photoFrom, text, voiceFrom } from "@/lib/server/http";
import { createReport, UserError } from "@/lib/server/reports";
import { runtime as app } from "@/lib/server/runtime";

export const runtime = "nodejs";

export async function POST(req: Request) {
  return handle(async () => {
    const form = await req.formData();
    const [photo, voice] = await Promise.all([photoFrom(form), voiceFrom(form)]);
    const description = text(form, "description");
    if (!photo && !voice && !description) throw new UserError("Add a photo, a message or a recording.");
    // An uploaded photo's EXIF fills in what the form left out: the spot and the time it was taken.
    const meta = photo && !("sample_id" in photo) ? (photo.meta ?? null) : null;
    const typed = text(form, "lat") !== null || text(form, "lng") !== null;
    const { lat, lng } = !typed && meta?.lat != null && meta.lng != null ? { lat: meta.lat, lng: meta.lng } : location(form);
    const now = new Date().toISOString();
    const observed = text(form, "observed_at") ?? meta?.taken_at ?? null;
    const exifTime = text(form, "observed_at") ? text(form, "observed_at_source") === "exif" : Boolean(meta?.taken_at);
    return createReport(await app(), {
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
