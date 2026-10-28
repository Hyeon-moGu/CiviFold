// Author: HyeonMo Gu
// Created: 2026-10-27

// Negative control: a look-alike hydrant (H5: same model, different street spot)
// must NOT be judged "same" as H1. Compared against H1's front and close-up shots.
// Needs .cache/smoke/h1-front.webp and h1-closeup.webp from image.ts and viewpoints.ts.
import { toFile } from "openai";
import { meta, MODELS } from "../../lib/meta/client";
import { Comparison, compare } from "./compare";
import { load, mimeOf, save, timed } from "./common";

const H5 =
  "A different fire hydrant of exactly the same model and color, on another part of the same street. Replace the " +
  'surroundings with: a brown brick wall with a blue door, a black metal bollard, a gray awning with a shop sign reading "LAUNDRY". ' +
  "Same type of damage: top cap missing, water bubbling out of the top. Overcast daytime, eye level, about 3 meters away. " +
  "No people, no vehicles.";

async function main() {
  const h1Front = await load("h1-front.webp");
  const h1Closeup = await load("h1-closeup.webp");

  const h5 = await timed("edit H5 look-alike front", async () => {
    const image = await toFile(h1Front, "h1-front.webp", { type: mimeOf(h1Front) });
    const res = (await meta().images.edit({
      model: MODELS.image,
      image,
      prompt: H5,
      size: "1536x1024",
      output_format: "webp",
      reasoning_strength: "high",
    } as never)) as { data?: Array<{ b64_json?: string }> };
    const b64 = res.data?.[0]?.b64_json;
    if (!b64) throw new Error("no image");
    return Buffer.from(b64, "base64");
  });
  console.log("  →", await save("h5-front.webp", h5));

  const pairs = [
    ["H5 front vs H1 front (expect different)", h5, h1Front],
    ["H5 front vs H1 closeup (expect unsure/different)", h5, h1Closeup],
    ["H1 closeup vs H5 front (order swapped)", h1Closeup, h5],
  ] as const;
  for (const [label, n1, c1] of pairs) {
    const res = await timed(label, () => compare(n1, c1));
    const parsed = Comparison.safeParse(JSON.parse(res.choices[0]?.message.content ?? "null"));
    if (!parsed.success) {
      console.log("  invalid output:", res.choices[0]?.message.content);
      continue;
    }
    console.log(`  → ${parsed.data.same_asset} (${parsed.data.confidence}): ${parsed.data.evidence.join(" | ")}`);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
