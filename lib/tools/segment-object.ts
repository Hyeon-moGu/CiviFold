// Author: HyeonMo Gu
// Created: 2026-10-27

import { createHash } from "node:crypto";
import { decodeMaskToSVGPath, type SegmentationBoxRecord, type SegmentationMaskRecord } from "@meta-sam/parser";
import sharp from "sharp";
import { z } from "zod";
import { segment } from "../meta/sam";
import { dataUrl, type ImageKind, type ImageRow } from "./images";
import { Box, ImageId, type Category, type ToolContext, type Tool } from "./types";

const OBJECT_MARGIN = 0.1; // each side, as a fraction of the box
const CONTEXT_SCALE = 3; // context crop is this many box sizes around the box center
const CONTEXT_MIN_FRACTION = 0.5; // ...but at least half the frame per axis, so a distant object keeps its landmarks

/** SAM phrase per category when a report has no usable phrase of its own. */
export const DEFAULT_SAM_PROMPT: Record<Category, string> = {
  fire_hydrant: "fire hydrant",
  streetlight: "street light",
  traffic_sign: "traffic sign",
  bench: "bench",
  road_damage: "pothole",
  trash: "trash",
  graffiti: "graffiti",
  other: "object",
};

export const SegmentObjectIn = z
  .object({
    image_id: ImageId,
    noun_phrase: z.string().describe("1–3 words, one concept, no 'and', no lists, no spatial words"),
  })
  .strict();

export const SegmentObjectOut = z
  .object({
    found: z.boolean(),
    instances: z.number().describe("How many matching objects SAM returned"),
    chosen: z
      .object({ box: Box, score: z.number().nullable(), object_crop_id: ImageId, context_crop_id: ImageId })
      .strict()
      .nullable(),
  })
  .strict();

export const segmentObject: Tool<typeof SegmentObjectIn, typeof SegmentObjectOut> = {
  name: "segment_object",
  description:
    "Segment one object in an image with SAM 3.1 and create two crops: the object itself and a wider " +
    'context crop. Use a short noun phrase for ONE concept (e.g. "fire hydrant", "hydrant cap"). ' +
    "Try a different noun phrase if the first result picked the wrong object.",
  input: SegmentObjectIn,
  output: SegmentObjectOut,
  run: async ({ image_id, noun_phrase }, ctx) => {
    const phrase = noun_phrase.trim().toLowerCase();
    const problem = checkNounPhrase(phrase);
    if (problem) throw new Error(problem);
    const image = await ctx.images.get(image_id);
    if (!image) throw new Error(`Unknown image ${image_id}`);
    const bytes = await ctx.images.bytes(image_id);

    const sam = await segment(dataUrl(bytes, image.mime), phrase, { mode: ctx.mode, signal: ctx.signal });
    const best = chooseInstance(sam.boxes, image.width, image.height);
    if (!best) {
      await ctx.images.saveSegmentation({
        image_id,
        noun_phrase: phrase,
        found: false,
        instances: 0,
        box: null,
        score: null,
        mask_svg_path: null,
        object_crop_id: null,
        context_crop_id: null,
      });
      return { found: false, instances: 0, chosen: null };
    }

    const box: Box = { x1: best.left, y1: best.top, x2: best.right, y2: best.bottom, w: image.width, h: image.height };
    const [objectCrop, contextCrop] = await Promise.all([
      saveCrop(image, bytes, "object_crop", objectCropRect(box), ctx),
      saveCrop(image, bytes, "context_crop", contextCropRect(box), ctx),
    ]);
    const score = best.confidence ?? null;
    await ctx.images.saveSegmentation({
      image_id,
      noun_phrase: phrase,
      found: true,
      instances: sam.boxes.length,
      box,
      score,
      mask_svg_path: maskPath(sam.masks, best.objectId),
      object_crop_id: objectCrop,
      context_crop_id: contextCrop,
    });
    return { found: true, instances: sam.boxes.length, chosen: { box, score, object_crop_id: objectCrop, context_crop_id: contextCrop } };
  },
};

/** An error message when SAM cannot take the phrase as one concept, otherwise null. */
export function checkNounPhrase(phrase: string): string | null {
  if (phrase.trim() === "") return "Noun phrase is empty";
  if (/,|\b(and|or)\b/i.test(phrase)) return `"${phrase}" names more than one concept; segment them one at a time`;
  return null;
}

// The reported object is usually what the resident centered: weigh SAM's score by closeness to the frame center.
export function chooseInstance(boxes: readonly SegmentationBoxRecord[], width: number, height: number): SegmentationBoxRecord | null {
  const halfDiagonal = Math.hypot(width / 2, height / 2);
  const weight = (b: SegmentationBoxRecord) => {
    const off = Math.hypot((b.left + b.right) / 2 - width / 2, (b.top + b.bottom) / 2 - height / 2);
    return (b.confidence ?? 1) * (1 - off / halfDiagonal);
  };
  return boxes.reduce<SegmentationBoxRecord | null>((best, b) => (best === null || weight(b) > weight(best) ? b : best), null);
}

export type Rect = { left: number; top: number; width: number; height: number };

export function objectCropRect(box: Box): Rect {
  const mx = (box.x2 - box.x1) * OBJECT_MARGIN;
  const my = (box.y2 - box.y1) * OBJECT_MARGIN;
  return clampRect(box.x1 - mx, box.y1 - my, box.x2 + mx, box.y2 + my, box.w, box.h);
}

// Near an edge the window slides inward instead of shrinking.
export function contextCropRect(box: Box): Rect {
  const width = Math.min(box.w, Math.ceil(Math.max((box.x2 - box.x1) * CONTEXT_SCALE, box.w * CONTEXT_MIN_FRACTION)));
  const height = Math.min(box.h, Math.ceil(Math.max((box.y2 - box.y1) * CONTEXT_SCALE, box.h * CONTEXT_MIN_FRACTION)));
  const left = Math.round(Math.min(box.w - width, Math.max(0, (box.x1 + box.x2) / 2 - width / 2)));
  const top = Math.round(Math.min(box.h - height, Math.max(0, (box.y1 + box.y2) / 2 - height / 2)));
  return { left, top, width, height };
}

function clampRect(x1: number, y1: number, x2: number, y2: number, w: number, h: number): Rect {
  const left = Math.max(0, Math.floor(x1));
  const top = Math.max(0, Math.floor(y1));
  const right = Math.min(w, Math.ceil(x2));
  const bottom = Math.min(h, Math.ceil(y2));
  return { left, top, width: Math.max(1, right - left), height: Math.max(1, bottom - top) };
}

async function saveCrop(source: ImageRow, bytes: Buffer, kind: ImageKind, rect: Rect, ctx: Pick<ToolContext, "images">): Promise<string> {
  const key = `${source.id}:${kind}:${rect.left},${rect.top},${rect.width},${rect.height}`;
  const id = `img_${createHash("sha256").update(key).digest("hex").slice(0, 12)}`;
  if (await ctx.images.get(id)) return id;
  const crop = await sharp(bytes).extract(rect).webp({ quality: 90 }).toBuffer();
  await ctx.images.put(
    { id, report_id: source.report_id, kind, source_image_id: source.id, width: rect.width, height: rect.height, mime: "image/webp", is_synthetic: source.is_synthetic },
    crop,
  );
  return id;
}

// Large masks arrive downscaled, so the raster is scaled to its bounds before it is placed.
function maskPath(masks: readonly SegmentationMaskRecord[], objectId: string): string | null {
  const mask = masks.filter((m) => m.objectId === objectId).sort((a, b) => b.revision - a.revision)[0];
  if (!mask) return null;
  const sx = (mask.bounds.right - mask.bounds.left) / mask.mask.width;
  const sy = (mask.bounds.bottom - mask.bounds.top) / mask.mask.height;
  return `<path d="${decodeMaskToSVGPath(mask.mask)}" transform="translate(${mask.bounds.left} ${mask.bounds.top}) scale(${sx} ${sy})"/>`;
}
