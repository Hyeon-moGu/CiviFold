// Author: HyeonMo Gu
// Created: 2026-10-27

import { eq } from "drizzle-orm";
import { images } from "@/lib/db/schema";
import { runtime as app } from "@/lib/server/runtime";
import { imageResponse } from "@/lib/server/thumbnail";

export const runtime = "nodejs";

// Photos are private in the blob store and read through here, by image id only. ?w=240|480|960 resizes.
export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { database, store } = await app();
  const [row] = await database.select().from(images).where(eq(images.id, (await params).id));
  if (!row) return new Response("Not found", { status: 404 });
  return imageResponse(await store.get(row.storage_path), row.mime, new URL(req.url).searchParams.get("w"), row.is_synthetic);
}
