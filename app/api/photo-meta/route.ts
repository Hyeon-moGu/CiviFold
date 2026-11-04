// Author: HyeonMo Gu
// Created: 2026-10-27

import { formOf, handle, text } from "@/lib/server/http";
import { photoMeta } from "@/lib/server/photo-meta";
import { UserError } from "@/lib/server/reports";

export const runtime = "nodejs";

// Reads where and when a chosen photo was taken, so the form can fill itself in. Nothing is stored and
// no model is called; HEIC is read here too, though only JPEG, PNG and WebP can be submitted. The browser
// sends only the start of the file, where the EXIF is, to stay under a deployment's request size limit.
export async function POST(req: Request) {
  return handle(async () => {
    const form = await formOf(req);
    const file = form.get("photo");
    if (!(file instanceof File) || file.size === 0) throw new UserError("No photo.");
    if (file.size > 25 * 1024 * 1024) throw new UserError("That photo is too large.");
    const offset = Number(text(form, "tz_offset"));
    return photoMeta(Buffer.from(await file.arrayBuffer()), Number.isFinite(offset) ? offset : null);
  });
}
