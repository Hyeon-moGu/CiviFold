// Author: HyeonMo Gu
// Created: 2026-10-27

import { samples } from "@/lib/dataset/static";

export const runtime = "nodejs";

export function GET() {
  return Response.json(samples());
}
