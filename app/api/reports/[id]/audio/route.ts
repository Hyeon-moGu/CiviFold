// Author: HyeonMo Gu
// Created: 2026-10-27

import { eq } from "drizzle-orm";
import { reports } from "@/lib/db/schema";
import { runtime as app } from "@/lib/server/runtime";

export const runtime = "nodejs";

// Recordings are private in the blob store and read through here, by report id only.
export async function GET(_: Request, { params }: { params: Promise<{ id: string }> }) {
  const { database, store } = await app();
  const [row] = await database.select({ audio_path: reports.audio_path }).from(reports).where(eq(reports.id, (await params).id));
  if (!row?.audio_path) return new Response("Not found", { status: 404 });
  const bytes = await store.get(row.audio_path);
  return new Response(new Uint8Array(bytes), { headers: { "Content-Type": "audio/wav", "Content-Length": String(bytes.length), "Cache-Control": "private, max-age=3600" } });
}
