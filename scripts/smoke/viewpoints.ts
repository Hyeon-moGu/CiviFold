// Author: HyeonMo Gu
// Created: 2026-10-27

// Can Muse Image produce the viewpoints real reporters use
// (across the street, close-up, far along the sidewalk, crouched low) while the
// hydrant and its landmarks stay recognizably the same? Each variant is edited
// from the H1 anchor, then compared back to it with Muse Spark.
// Needs .cache/smoke/h1-front.webp from `npm run smoke:image`.
import { toFile } from "openai";
import sharp from "sharp";
import { meta, MODELS } from "../../lib/meta/client";
import { Comparison, compare } from "./compare";
import { load, mimeOf, save, timed } from "./common";

const KEEP =
  "Keep the hydrant, its missing top cap and the bubbling water, the yellow stucco wall, the green metal bike " +
  'rack, the striped red-and-white awning and the "BAKERY" sign identical. No people, no vehicles.';

const VARIANTS = [
  {
    name: "across",
    size: "1536x1024",
    prompt:
      "The same hydrant and storefront photographed by a pedestrian standing on the opposite sidewalk, across an " +
      "empty two-lane street, about 15 meters away and slightly to the left. The asphalt road with lane markings " +
      "fills the lower third of the frame. The hydrant is small, about one eighth of the frame height. " +
      KEEP,
  },
  {
    name: "closeup",
    size: "1024x1536",
    prompt:
      "Vertical handheld smartphone photo taken from about 50 centimeters away, standing over the same hydrant and " +
      "looking down at the open top where the cap is missing and water bubbles out. The top of the hydrant fills " +
      "most of the frame and the wet sidewalk is visible around it; only a small, blurred patch of the yellow " +
      "stucco wall shows at the top edge. The bike rack, awning and sign are out of frame.",
  },
  {
    name: "sidewalk",
    size: "1536x1024",
    prompt:
      "The same scene photographed from about 8 meters further down the same sidewalk, so the camera looks along " +
      "the sidewalk and the storefront is seen at a steep angle. The hydrant is seen from its side, with the water " +
      "pooling on the pavement in front of it; the bike rack is partly hidden behind the hydrant. " +
      KEEP,
  },
  {
    name: "low-right",
    size: "1536x1024",
    prompt:
      "The same hydrant photographed by another person from about 4 meters away and 60 degrees to the right of the " +
      "original camera position, crouching so the camera is near knee height and looking slightly up. More of the " +
      "street corner to the right of the bakery is visible. " +
      KEEP,
  },
] as const;

type ImageResult = { data?: Array<{ b64_json?: string }> };

async function main() {
  const anchor = await load("h1-front.webp");
  const client = meta();

  const results: Array<{ name: string; bytes: Buffer }> = [];
  for (const v of VARIANTS) {
    const bytes = await timed(`edit ${v.name} (${v.size})`, async () => {
      const image = await toFile(anchor, "h1-front.webp", { type: mimeOf(anchor) });
      const res = (await client.images.edit({
        model: MODELS.image,
        image,
        prompt: v.prompt,
        size: v.size,
        output_format: "webp",
        reasoning_strength: "high",
      } as never)) as ImageResult;
      const b64 = res.data?.[0]?.b64_json;
      if (!b64) throw new Error(`no image: ${JSON.stringify(res).slice(0, 300)}`);
      return Buffer.from(b64, "base64");
    });
    const { width, height } = await sharp(bytes).metadata();
    console.log(`  → ${await save(`h1-${v.name}.webp`, bytes)} (${width}x${height})`);
    results.push({ name: v.name, bytes });
  }

  // Contact sheet: anchor + variants, each scaled to the same height.
  const tiles = await Promise.all(
    [anchor, ...results.map((r) => r.bytes)].map((b) => sharp(b).resize({ height: 400 }).jpeg().toBuffer({ resolveWithObject: true })),
  );
  let left = 0;
  const composites = tiles.map((t) => {
    const c = { input: t.data, left, top: 0 };
    left += t.info.width + 8;
    return c;
  });
  const sheet = await sharp({ create: { width: left, height: 400, channels: 3, background: "#ffffff" } })
    .composite(composites)
    .jpeg({ quality: 80 })
    .toBuffer();
  console.log("  sheet →", await save("h1-viewpoints-sheet.jpg", sheet));

  console.log("\nSpark: anchor (C1) vs each variant (N1)");
  for (const r of results) {
    const res = await timed(`compare ${r.name}`, () => compare(r.bytes, anchor));
    const parsed = Comparison.safeParse(JSON.parse(res.choices[0]?.message.content ?? "null"));
    if (!parsed.success) {
      console.log("  invalid output:", res.choices[0]?.message.content);
      continue;
    }
    const { same_asset, confidence, evidence } = parsed.data;
    console.log(`  ${r.name}: ${same_asset} (${confidence}) — ${evidence.join(" | ")}`);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
