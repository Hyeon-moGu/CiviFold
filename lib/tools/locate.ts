// Author: HyeonMo Gu
// Created: 2026-11-03

import { z } from "zod";
import type { CallInfo, Mode } from "../meta/call";
import { sparkJson } from "../meta/spark";
import { loadPrompt } from "../prompts";
import type { Category } from "./types";

const Located = z.object({ visible: z.boolean(), x1: z.number(), y1: z.number(), x2: z.number(), y2: z.number() }).strict();

export type PixelBox = { left: number; top: number; right: number; bottom: number };

/**
 * Where Muse Spark sees the reported thing in a photo, in pixels with half-open right and bottom, or null when
 * it is not visible. SAM then segments inside this box, so a look-alike part of the scene (a road marking, the
 * fixture next door) is not cut out instead.
 */
export async function locate(
  image: { url: string; width: number; height: number },
  what: { category: Category | null; phrase: string },
  opts: { mode?: Mode; signal?: AbortSignal },
): Promise<{ box: PixelBox | null; call: CallInfo }> {
  const prompt = await loadPrompt("locate");
  const { data, call } = await sparkJson({
    name: "locate",
    schema: Located,
    mode: opts.mode,
    signal: opts.signal,
    messages: [
      { role: "system", content: prompt.text },
      {
        role: "user",
        content: [
          { type: "text", text: `Report kind: ${what.category?.replace("_", " ") ?? "unknown"}. Thing to box: ${what.phrase}.` },
          { type: "image_url", image_url: { url: image.url } },
        ],
      },
    ],
  });
  return { box: data.visible ? toPixels(data, image.width, image.height) : null, call };
}

/** A 0-1000 box in pixels, kept inside the image; null when it has no area. */
export function toPixels(b: { x1: number; y1: number; x2: number; y2: number }, width: number, height: number): PixelBox | null {
  const x = (v: number) => Math.max(0, Math.min(width, Math.round((v * width) / 1000)));
  const y = (v: number) => Math.max(0, Math.min(height, Math.round((v * height) / 1000)));
  const box = { left: x(Math.min(b.x1, b.x2)), top: y(Math.min(b.y1, b.y2)), right: x(Math.max(b.x1, b.x2)), bottom: y(Math.max(b.y1, b.y2)) };
  return box.right > box.left && box.bottom > box.top ? box : null;
}
