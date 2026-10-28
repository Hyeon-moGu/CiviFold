// Author: HyeonMo Gu
// Created: 2026-10-27

// The after-fix check: before the rules call a report "already fixed" (or find neither problem nor fix),
// each photo is looked at again in zoomed tiles. A full photo is scaled down before the model sees it, so
// a hairline crack or a small dent can vanish; at full resolution it may not.
import sharp from "sharp";
import { z } from "zod";
import { sparkJson } from "../meta/spark";
import { loadPrompt } from "../prompts";
import { dataUrl } from "../tools/images";
import type { ToolContext } from "../tools/types";

export const AfterFixResult = z
  .object({
    problem_found: z.boolean(),
    tile: z.number().int().nullable(),
    description: z.string().nullable(),
  })
  .strict();

export type AfterFixResult = z.infer<typeof AfterFixResult>;

const OVERVIEW_WIDTH = 960;
const TILE_SHARE = 0.55; // each tile spans a bit more than half the photo, so the four overlap

/** One check per photo, keyed by image id. A failed call leaves that photo out and is recorded in `errors`. */
export async function checkAfterFix(imageIds: string[], subject: string, ctx: Pick<ToolContext, "images" | "mode">, errors: string[]): Promise<Record<string, AfterFixResult>> {
  const prompt = await loadPrompt("after_fix");
  const results = await Promise.all(
    imageIds.map(async (id) => {
      try {
        const parts = await tiles(await ctx.images.bytes(id));
        const { data } = await sparkJson({
          name: "after_fix",
          schema: AfterFixResult,
          mode: ctx.mode,
          messages: [
            { role: "system", content: prompt.text },
            {
              role: "user",
              content: [
                { type: "text", text: `Reported fixture or spot: ${subject}` },
                ...parts.flatMap((bytes, i) => [
                  { type: "text" as const, text: i === 0 ? "WHOLE PHOTO" : `TILE ${i}` },
                  { type: "image_url" as const, image_url: { url: dataUrl(bytes, "image/webp") } },
                ]),
              ],
            },
          ],
        });
        return [id, data] as const;
      } catch (err) {
        errors.push(`after_fix ${id}: ${String(err)}`);
        return null;
      }
    }),
  );
  return Object.fromEntries(results.filter((r) => r !== null));
}

async function tiles(bytes: Buffer): Promise<Buffer[]> {
  const image = sharp(bytes);
  const { width = 0, height = 0 } = await image.metadata();
  const [w, h] = [Math.round(width * TILE_SHARE), Math.round(height * TILE_SHARE)];
  const corners = [
    [0, 0],
    [width - w, 0],
    [0, height - h],
    [width - w, height - h],
  ] as const;
  const overview = await sharp(bytes).resize({ width: OVERVIEW_WIDTH }).webp({ quality: 80 }).toBuffer();
  const zoomed = await Promise.all(corners.map(([left, top]) => sharp(bytes).extract({ left, top, width: w, height: h }).webp({ quality: 90 }).toBuffer()));
  return [overview, ...zoomed];
}
