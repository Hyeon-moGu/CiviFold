// Author: HyeonMo Gu
// Created: 2026-10-27

import { ASSET_FILE } from "@/lib/dataset/static";
import { seedDemo } from "@/lib/demo/seed";
import { handle } from "@/lib/server/http";
import { runtime as app } from "@/lib/server/runtime";

export const runtime = "nodejs";

export async function POST() {
  return handle(async () => seedDemo((await app()).database, ASSET_FILE));
}
