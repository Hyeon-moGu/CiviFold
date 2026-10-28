// Author: HyeonMo Gu
// Created: 2026-10-27

// Smoke images for a problem tied to a place (illegal dumping W1): anchor, a view from across the
// street, the spot after cleanup, a look-alike pile elsewhere (W5), and one out-of-scope noise complaint.
// Existing outputs are kept, so a rerun only fills in what is missing.
// Outputs: .cache/smoke/w1-front.webp, w1-across.webp, w1-cleaned.webp, w5-front.webp, person.webp
import { toFile } from "openai";
import { meta, MODELS } from "../../lib/meta/client";
import { load, mimeOf, save, timed } from "./common";

const TAIL =
  "Realistic smartphone photo, natural colors, slight lens imperfections. No people, no faces, " +
  'no vehicles, no license plates, no watermark, no text other than: "BARBER".';

const W1 =
  "Eye-level smartphone photo, taken from about 4 meters away, of a pile of black garbage bags and a torn gray " +
  "mattress dumped against a wall on the sidewalk of a quiet city street, overcast daytime. Clearly visible behind " +
  "and around it: a red brick wall with a faded blue wave mural, a green metal electrical cabinet, and a corner shop " +
  'sign reading "BARBER". The pile is in the center of the frame and fully visible. ' +
  TAIL;

const KEEP =
  "Keep the garbage bags, the torn mattress, the red brick wall with the blue wave mural, the green electrical " +
  'cabinet and the "BARBER" sign identical. No people, no vehicles.';

const EDITS = [
  {
    name: "w1-across",
    prompt:
      "The same spot photographed by a pedestrian standing on the opposite sidewalk, across an empty two-lane street, " +
      "about 15 meters away and slightly to the left. The asphalt road with lane markings fills the lower third of the " +
      "frame. The pile is small, about one eighth of the frame height. " +
      KEEP,
  },
  {
    name: "w1-cleaned",
    prompt:
      "Same scene and viewpoint, a few days later. The dumped garbage bags and mattress have been removed: the sidewalk " +
      "in front of the wall is swept clean and slightly wet from washing. Nothing else changes. No people, no vehicles.",
  },
  {
    name: "w5-front",
    prompt:
      "A different spot on another part of the same street, with a very similar pile of black garbage bags and a torn " +
      "gray mattress dumped on the sidewalk. Replace the surroundings with: a plain gray concrete wall, a white metal " +
      'electrical cabinet, and a shop sign reading "BOUTIQUE". Overcast daytime, eye level, about 4 meters away. ' +
      "No people, no vehicles.",
  },
] as const;

const PERSON =
  "Smartphone photo of a city sidewalk in the evening. A man seen from behind, so his face is not visible, stands " +
  "next to a large portable speaker playing music loudly in front of an apartment building entrance. Realistic, " +
  "natural colors. No readable text, no license plates, no watermark.";

const OPTS = { size: "1536x1024", output_format: "webp", reasoning_strength: "high" };

type ImageResult = { data?: Array<{ b64_json?: string }> };

function decode(res: ImageResult): Buffer {
  const b64 = res.data?.[0]?.b64_json;
  if (!b64) throw new Error(`no image: ${JSON.stringify(res).slice(0, 300)}`);
  return Buffer.from(b64, "base64");
}

async function generate(name: string, prompt: string): Promise<Buffer> {
  const bytes = await timed(`generate ${name}`, async () =>
    decode((await meta().images.generate({ model: MODELS.image, prompt, n: 1, ...OPTS } as never)) as ImageResult),
  );
  console.log("  →", await save(`${name}.webp`, bytes));
  return bytes;
}

async function main() {
  const anchor = await load("w1-front.webp").catch(() => generate("w1-front", W1));
  for (const e of EDITS) {
    if (await load(`${e.name}.webp`).catch(() => null)) continue;
    const bytes = await timed(`edit ${e.name}`, async () => {
      const image = await toFile(anchor, "w1-front.webp", { type: mimeOf(anchor) });
      return decode((await meta().images.edit({ model: MODELS.image, image, prompt: e.prompt, ...OPTS } as never)) as ImageResult);
    });
    console.log("  →", await save(`${e.name}.webp`, bytes));
  }
  await generate("person", PERSON);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
