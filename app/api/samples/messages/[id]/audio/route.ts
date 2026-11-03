// Author: HyeonMo Gu
// Created: 2026-10-27

import { messageSample, voiceBlobKey } from "@/lib/dataset/messages";
import { runtime as app } from "@/lib/server/runtime";

export const runtime = "nodejs";

export async function GET(_: Request, { params }: { params: Promise<{ id: string }> }) {
  const sample = messageSample((await params).id);
  if (sample?.kind !== "voice") return new Response("Not found", { status: 404 });
  const { store } = await app();
  let bytes: Buffer;
  try {
    bytes = await store.get(voiceBlobKey(sample.id));
  } catch (err) {
    // The sample's recording is uploaded by the seed; before that, or if it was lost, the sample has no audio.
    console.error(`voice sample ${sample.id} unreadable:`, (err as Error).message);
    return new Response("Not found", { status: 404 });
  }
  return new Response(new Uint8Array(bytes), { headers: { "Content-Type": "audio/wav", "Content-Length": String(bytes.length), "Cache-Control": "public, max-age=86400" } });
}
