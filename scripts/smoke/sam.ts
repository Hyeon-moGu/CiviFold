// Author: HyeonMo Gu
// Created: 2026-10-27

// SAM 3.1 smoke test: segment "fire hydrant" on the H1 anchor and save a mask overlay PNG.
// Image requests must be unary (stream: false); a streaming image request fails upstream,
// so the JSON body is adapted into the event stream @meta-sam/parser expects.
import { decodeMaskToSVGPath, parseImageStream, recordsOfKind, type ResponsesEvent } from "@meta-sam/parser";
import sharp from "sharp";
import { metaPost, MODELS } from "../../lib/meta/client";
import { dataUrl, load, mimeOf, save, timed } from "./common";

type SamResponse = {
  status: string;
  output?: Array<{ id?: string; content?: Array<{ type: string; text?: string }> }>;
  incomplete_details?: unknown;
  error?: unknown;
  usage?: unknown;
};

async function* toEvents(body: SamResponse): AsyncIterable<ResponsesEvent> {
  for (const [outputIndex, item] of (body.output ?? []).entries()) {
    for (const [contentIndex, part] of (item.content ?? []).entries()) {
      if (part.type !== "output_text" || typeof part.text !== "string") continue;
      const lane = { item_id: item.id ?? "sam-image", output_index: outputIndex, content_index: contentIndex };
      yield { type: "response.output_text.delta", delta: part.text, ...lane } as ResponsesEvent;
      yield { type: "response.output_text.done", text: part.text, ...lane } as ResponsesEvent;
    }
  }
  yield { type: body.status === "completed" ? "response.completed" : "response.incomplete" } as ResponsesEvent;
}

async function segment(image: Buffer, phrase: string) {
  return metaPost<SamResponse>("responses", {
    model: MODELS.sam,
    stream: false,
    input: [
      {
        type: "message",
        role: "user",
        content: [
          { type: "input_text", text: phrase },
          { type: "input_image", image_url: dataUrl(image, mimeOf(image)) },
        ],
      },
    ],
    metadata: { include_confidence: "true" },
  });
}

async function main() {
  // Optional argument picks another smoke image, e.g. `npm run smoke:sam -- h1-across`.
  const name = process.argv[2] ?? "h1-front";
  const image = await load(`${name}.webp`);
  const { width = 0, height = 0 } = await sharp(image).metadata();

  const body = await timed(`segment "fire hydrant" (${mimeOf(image)} ${width}x${height})`, () =>
    segment(image, "fire hydrant"),
  );
  console.log("  status:", body.status, "| usage:", JSON.stringify(body.usage ?? null));

  const result = await parseImageStream(toEvents(body)).finalResult;
  for (const d of result.diagnostics) console.log(`  diagnostic ${d.severity} ${d.code}: ${d.message}`);

  const boxes = recordsOfKind(result.records, "box");
  const masks = recordsOfKind(result.records, "mask");
  console.log(`  objects: ${boxes.length}`);
  for (const b of boxes) {
    console.log(`   id=${b.objectId} box=[${b.left},${b.top},${b.right},${b.bottom}) c=${b.confidence?.toFixed(3) ?? "n/a"}`);
  }

  // Overlay: each mask path is in raster coordinates. The raster can be smaller than its
  // box (large masks come back capped near 1024 px), so scale it to the bounds, then translate.
  const paths = masks
    .map((m) => {
      const d = decodeMaskToSVGPath(m.mask);
      const sx = (m.bounds.right - m.bounds.left) / m.mask.width;
      const sy = (m.bounds.bottom - m.bounds.top) / m.mask.height;
      const transform = `translate(${m.bounds.left} ${m.bounds.top}) scale(${sx} ${sy})`;
      return `<path d="${d}" transform="${transform}" fill="rgba(0,160,255,0.45)" stroke="#00a0ff" stroke-width="3" vector-effect="non-scaling-stroke"/>`;
    })
    .join("");
  const rects = boxes
    .map(
      (b) =>
        `<rect x="${b.left}" y="${b.top}" width="${b.right - b.left}" height="${b.bottom - b.top}" fill="none" stroke="#ffcc00" stroke-width="4"/>`,
    )
    .join("");
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}">${paths}${rects}</svg>`;
  const overlay = await sharp(image).composite([{ input: Buffer.from(svg) }]).png().toBuffer();
  console.log("  →", await save(`${name}-sam.png`, overlay));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
