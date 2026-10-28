// Author: HyeonMo Gu
// Created: 2026-10-27

import sharp from "sharp";

const WIDTHS = new Set([240, 480, 960]);

/**
 * The photo itself, or a WebP resized to one of a few widths (so a gallery never ships 2 MB originals).
 * Only synthetic dataset photos may sit in shared caches; a resident's upload is cached by their browser alone.
 */
export async function imageResponse(bytes: Buffer, mime: string, width: string | null, synthetic: boolean): Promise<Response> {
  const w = Number(width);
  const body = WIDTHS.has(w) ? await sharp(bytes).resize({ width: w }).webp({ quality: 78 }).toBuffer() : bytes;
  return new Response(new Uint8Array(body), {
    headers: { "content-type": WIDTHS.has(w) ? "image/webp" : mime, "cache-control": synthetic ? "public, max-age=31536000, immutable" : "private, max-age=3600" },
  });
}
