// Author: HyeonMo Gu
// Created: 2026-10-27

import { readFile } from "node:fs/promises";
import { z } from "zod";
import type { ImageSize } from "../meta/image";
import { Category } from "../tools/types";

export const Asset = z.object({
  id: z.string(),
  category: Category,
  // Tune on dev, check direction on val, report test once. holdout, holdout2, holdout3: each made before a round of
  // rule changes, kept unseen during it, run once at its end (then development data like the rest).
  split: z.enum(["dev", "val", "test", "holdout", "holdout2", "holdout3"]),
  role: z.enum(["main", "lookalike"]),
  pair_of: z.string().nullable(),
  object: z.string(),
  object_short: z.string(),
  sam_prompt: z.string(),
  landmarks: z.array(z.string()).length(3),
  sign_texts: z.array(z.string()).min(1),
  offset_m: z.object({ dx: z.number(), dy: z.number() }),
  special_cases: z.array(z.enum(["time_conflict", "gps_small", "gps_large", "closeup_late", "sam_distractor"])),
  sunny_v2: z.boolean(),
  states: z.object({ damaged_v1: z.string(), repaired: z.string().optional(), damaged_v2: z.string().optional() }),
  prompt: z.string().describe("Anchor prompt for a main asset; edit prompt from the pair's first-damage front photo for a look-alike"),
});

export const AssetFile = z.object({ base: z.object({ lat: z.number(), lng: z.number() }), assets: z.array(Asset) });

export type Asset = z.infer<typeof Asset>;
export type AssetFile = z.infer<typeof AssetFile>;
export type State = "damaged_v1" | "repaired" | "damaged_v2";
export type View = "front" | "across" | "sidewalk" | "closeup" | "closeup_side" | "across_night" | "front_night";

// Muse Image returned the close-ups upright and every other view landscape; assets.test.ts checks every dataset photo.
export const VIEW_SIZE: Record<View, { width: number; height: number }> = {
  front: { width: 1920, height: 1280 },
  across: { width: 1920, height: 1280 },
  sidewalk: { width: 1920, height: 1280 },
  across_night: { width: 1920, height: 1280 },
  front_night: { width: 1920, height: 1280 },
  closeup: { width: 1280, height: 1920 },
  closeup_side: { width: 1280, height: 1920 },
};

// Scripts only: the app imports the JSON. The ignore stops the bundler from tracing the whole project for this read.
export async function loadAssets(file = "dataset/assets.json"): Promise<AssetFile> {
  return AssetFile.parse(JSON.parse(await readFile(/*turbopackIgnore: true*/ file, "utf8")));
}

export const imageId = (assetId: string, state: State, view: View) => `syn_${assetId}_${state}_${view}`;

/** One image to make: generated from `prompt`, or edited from the image `from`. */
export type ImageStep = { id: string; asset_id: string; state: State; view: View; from: string | null; prompt: string; size: ImageSize };

const TAIL = (signs: string[]) =>
  "Realistic smartphone photo, natural colors, slight lens imperfections. No people, no faces, no vehicles, " +
  `no license plates, no watermark, no text other than: ${signs.map((s) => `"${s}"`).join(", ")}.`;

const keep = (a: Asset) =>
  `the ${a.object_short} and its current condition, the ${a.landmarks.join(", the ")} and the ${a.sign_texts.map((s) => `"${s}"`).join(" and ")} sign`;

// Viewpoints change where the photographer stands, not just the angle: edits that only rotate the
// camera came back nearly identical to the anchor.
const ACROSS = (a: Asset) =>
  `The same ${a.object_short} and its surroundings photographed by a pedestrian standing on the opposite sidewalk, ` +
  "across an empty two-lane street, about 15 meters away and slightly to the left. The asphalt road with lane markings " +
  `fills the lower third of the frame and the ${a.object_short} looks small. Keep ${keep(a)} identical. No people, no vehicles.`;

const SIDEWALK = (a: Asset) =>
  "The same scene photographed from about 8 meters further along the same sidewalk, so the camera looks along the " +
  `street and the storefront is seen at a steep angle. Keep ${keep(a)} identical. No people, no vehicles.`;

// A resident cannot stand 50 cm from a lamp head several meters up: for tall fixtures the close-up looks up from below.
const CLOSEUP = (a: Asset) =>
  a.category === "streetlight"
    ? "Vertical handheld smartphone photo taken from directly below, looking straight up, so the damaged lamp head " +
      `fills most of the frame: ${a.states.damaged_v1}. Only a strip of overcast sky and the edge of the ${a.landmarks[0]} ` +
      "show; the other surroundings and the sign are out of frame. No people."
    : `Vertical handheld smartphone photo taken from about 50 centimeters away, looking down at the ${a.object_short} so the ` +
      `problem fills most of the frame: ${a.states.damaged_v1}. Only a small, blurred patch of the ${a.landmarks[0]} shows at ` +
      "the top edge; the other surroundings and the sign are out of frame. No people.";

// A second close-up of the same problem, so a resident asked for a close-up after the first one joined the incident
// sends a photo the incident does not already hold. A different spot, not a rotation: rotations came back near copies.
const CLOSEUP_SIDE = (a: Asset) =>
  a.category === "streetlight"
    ? "Vertical handheld smartphone photo taken from the sidewalk about 3 meters to the side of the pole, looking up at an angle, " +
      `so the damaged lamp head and the top of the pole fill most of the frame: ${a.states.damaged_v1}. Overcast sky behind; ` +
      "the sign is out of frame. No people."
    : `Vertical handheld smartphone photo taken from about 1 meter away, crouching to the left of the ${a.object_short} at knee height, ` +
      `so the problem and the ground right around it fill most of the frame: ${a.states.damaged_v1}. A blurred strip of the ` +
      `${a.landmarks[0]} shows behind; the other surroundings and the sign are out of frame. No people.`;

// The recurrence close-up: a resident asked for a close-up after a repair photographs the new problem itself.
const CLOSEUP_AFTER = (a: Asset) =>
  `Vertical handheld smartphone photo taken as close as a person standing on the sidewalk can get, aimed at the ${a.object_short} ` +
  `so the new problem fills most of the frame: ${a.states.damaged_v2}. Only a small, blurred patch of the ${a.landmarks[0]} shows ` +
  "at the edge; the other surroundings and the sign are out of frame. No people.";

const REPAIRED = (a: Asset) =>
  `Same scene and viewpoint, a few days later. The ${a.object_short} has been repaired or cleaned up: ${a.states.repaired}. ` +
  "Nothing else changes. No people, no vehicles.";

const RECURRED = (a: Asset) =>
  `Same scene and viewpoint, two weeks later. The problem is back in a different form: ${a.states.damaged_v2}. ` +
  `Nothing else changes.${a.sunny_v2 ? " Sunny afternoon light." : ""} No people, no vehicles.`;

const NIGHT = (a: Asset) =>
  `The same scene and viewpoint at night: dark sky, street lights and shop windows lit. Keep ${keep(a)} identical; ` +
  "only the lighting changes, and a broken light stays dark. No people, no vehicles.";

/** Images for one asset in dependency order; each `from` appears earlier in the list or in the pair's list. */
export function imagePlan(a: Asset, pair: Asset | null): ImageStep[] {
  const step = (state: State, view: View, from: string | null, prompt: string, size: ImageSize = "1536x1024"): ImageStep => ({
    id: imageId(a.id, state, view),
    asset_id: a.id,
    state,
    view,
    from,
    prompt,
    size,
  });
  const firstFront = imageId(a.id, "damaged_v1", "front");
  if (a.role === "lookalike") {
    if (!pair) throw new Error(`${a.id} needs its pair`);
    return [
      step("damaged_v1", "front", imageId(pair.id, "damaged_v1", "front"), `${a.prompt} No people, no vehicles.`),
      step("damaged_v1", "across", firstFront, ACROSS(a)),
    ];
  }
  const fixed = imageId(a.id, "repaired", "front");
  const back = imageId(a.id, "damaged_v2", "front");
  return [
    step("damaged_v1", "front", null, `${a.prompt} ${TAIL(a.sign_texts)}`),
    step("damaged_v1", "across", firstFront, ACROSS(a)),
    step("damaged_v1", "sidewalk", firstFront, SIDEWALK(a)),
    step("damaged_v1", "closeup", firstFront, CLOSEUP(a), "1024x1536"),
    step("damaged_v1", "closeup_side", firstFront, CLOSEUP_SIDE(a), "1024x1536"),
    step("repaired", "front", firstFront, REPAIRED(a)),
    step("repaired", "across", imageId(a.id, "damaged_v1", "across"), REPAIRED(a)),
    step("damaged_v2", "front", fixed, RECURRED(a)),
    step("damaged_v2", "sidewalk", back, SIDEWALK(a)),
    step("damaged_v2", "closeup", back, CLOSEUP_AFTER(a), "1024x1536"),
    // Stress views: the same reports photographed at night.
    step("damaged_v1", "across_night", imageId(a.id, "damaged_v1", "across"), NIGHT(a)),
    step("damaged_v2", "front_night", back, NIGHT(a)),
  ];
}
