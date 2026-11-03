// Author: HyeonMo Gu
// Created: 2026-10-27

import { eq } from "drizzle-orm";
import { images } from "@/lib/db/schema";
import { storedBytes } from "@/lib/db/stores";
import { runtime as app } from "@/lib/server/runtime";
import { imageResponse } from "@/lib/server/thumbnail";

export const runtime = "nodejs";

// Photos are private in the blob store and read through here, by image id only. ?w=240|480|960 resizes.
export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { database, store } = await app();
  const [row] = await database
    .select({ storage_path: images.storage_path, bytes: images.bytes, mime: images.mime, is_synthetic: images.is_synthetic })
    .from(images)
    .where(eq(images.id, (await params).id));
  if (!row) return new Response("Not found", { status: 404 });
  let bytes: Buffer;
  try {
    bytes = await storedBytes(row, store);
  } catch (err) {
    // A row whose file is gone (a reset racing this read, or a lost upload) is a missing photo, not a server fault.
    console.error(`image ${row.storage_path ?? "(inline)"} unreadable:`, (err as Error).message);
    return new Response("Not found", { status: 404 });
  }
  return imageResponse(bytes, row.mime, new URL(req.url).searchParams.get("w"), row.is_synthetic);
}
