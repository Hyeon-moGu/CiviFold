// Author: HyeonMo Gu
// Created: 2026-10-27

// Muse Image smoke test: one anchor generation and two viewpoint edits of hydrant H1.
import { toFile } from "openai";
import { meta, MODELS } from "../../lib/meta/client";
import { mimeOf, save, timed } from "./common";

const TAIL =
  "Realistic smartphone photo, natural colors, slight lens imperfections. No people, no faces, " +
  'no vehicles, no license plates, no watermark, no text other than: "BAKERY".';

const ANCHOR =
  "Eye-level smartphone photo, taken from about 3 meters in front of a red fire hydrant with white caps " +
  "on the sidewalk of a quiet city street, overcast daytime. Clearly visible behind and around it: a yellow " +
  'stucco wall, a green metal bike rack, a striped red-and-white awning with a shop sign reading "BAKERY". ' +
  "The hydrant is damaged: its top cap is missing and water is bubbling out of the top and pooling on the " +
  "sidewalk. The hydrant is in the center of the frame and fully visible. " +
  TAIL;

const angleEdit = (side: "left" | "right") =>
  `The same place photographed from about 45 degrees to the ${side} of the original camera position, ` +
  "same distance and height. Keep the hydrant, its damage, the yellow stucco wall, the green metal bike rack, " +
  'the striped awning and the "BAKERY" sign identical; only the viewpoint changes.';

// The API rejects unknown fields with 400, so a rejected call is retried without these.
const OPTIONAL = { size: "1536x1024", output_format: "webp", reasoning_strength: "high" };

type ImageResult = { data?: Array<{ b64_json?: string; url?: string }> };

async function toBuffer(res: ImageResult): Promise<Buffer> {
  const item = res.data?.[0];
  if (item?.b64_json) return Buffer.from(item.b64_json, "base64");
  if (item?.url) return Buffer.from(await (await fetch(item.url)).arrayBuffer());
  throw new Error(`No image in response: ${JSON.stringify(res).slice(0, 300)}`);
}

async function withOptionalFallback<T>(label: string, call: (extra: object) => Promise<T>): Promise<T> {
  try {
    return await call(OPTIONAL);
  } catch (err) {
    console.log(`  ${label}: optional fields rejected → retry without them\n  ${String(err).slice(0, 400)}`);
    return await call({});
  }
}

async function writeImage(name: string, bytes: Buffer): Promise<void> {
  const ext = mimeOf(bytes).split("/")[1] ?? "bin";
  const file = await save(`${name}.${ext}`, bytes);
  console.log(`  → ${file} (${mimeOf(bytes)}, ${(bytes.length / 1024).toFixed(0)} KB)`);
}

async function main() {
  const client = meta();

  const anchor = await timed("generate H1 front", () =>
    withOptionalFallback("generate", (extra) =>
      client.images.generate({ model: MODELS.image, prompt: ANCHOR, n: 1, ...extra } as never) as Promise<ImageResult>,
    ).then(toBuffer),
  );
  await writeImage("h1-front", anchor);

  for (const side of ["left", "right"] as const) {
    const edited = await timed(`edit H1 ${side}45`, async () => {
      const image = await toFile(anchor, `h1-front.${mimeOf(anchor).split("/")[1]}`, { type: mimeOf(anchor) });
      return withOptionalFallback(`edit ${side}`, (extra) =>
        client.images.edit({ model: MODELS.image, image, prompt: angleEdit(side), ...extra } as never) as Promise<ImageResult>,
      ).then(toBuffer);
    });
    await writeImage(`h1-${side}45`, edited);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
