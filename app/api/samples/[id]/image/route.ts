// Author: HyeonMo Gu
// Created: 2026-10-27

import { sample } from "@/lib/dataset/static";
import { blobKey } from "@/lib/db/stores";
import { runtime as app } from "@/lib/server/runtime";
import { imageResponse } from "@/lib/server/thumbnail";

export const runtime = "nodejs";

export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const s = sample((await params).id);
  if (!s) return new Response("Not found", { status: 404 });
  const { store } = await app();
  const key = blobKey(s.id, "image/webp");
  // A sample the seed has not uploaded yet is missing, not a server error.
  if (!(await store.has(key))) return new Response("Not found", { status: 404 });
  return imageResponse(await store.get(key), "image/webp", new URL(req.url).searchParams.get("w"), true);
}
