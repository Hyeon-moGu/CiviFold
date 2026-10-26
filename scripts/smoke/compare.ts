// Author: HyeonMo Gu
// Created: 2026-10-27

// Shared by smoke scripts: one strict-JSON same-object comparison with Muse Spark.
import { z } from "zod";
import { meta, MODELS } from "../../lib/meta/client";
import { dataUrl, mimeOf } from "./common";

export const Comparison = z
  .object({
    same_asset: z.enum(["same", "different", "unsure"]),
    confidence: z.number(),
    evidence: z.array(z.string()),
    damage_difference: z.string().nullable().describe("null when the damage looks the same"),
  })
  .strict();

export const comparisonSchema = z.toJSONSchema(Comparison);

const PROMPT =
  "Two photos of street infrastructure follow, each preceded by its label. Decide whether IMAGE N1 and " +
  "IMAGE C1 show the same physical object (not just the same model). Base the decision only on observable " +
  "landmarks around the object. Give short evidence strings.";

export async function compare(n1: Buffer, c1: Buffer, extra: object = { temperature: 0 }) {
  return meta().chat.completions.create({
    model: MODELS.spark,
    messages: [
      {
        role: "user",
        content: [
          { type: "text", text: PROMPT },
          { type: "text", text: "IMAGE N1 — new report photo" },
          { type: "image_url", image_url: { url: dataUrl(n1, mimeOf(n1)) } },
          { type: "text", text: "IMAGE C1 — candidate incident photo" },
          { type: "image_url", image_url: { url: dataUrl(c1, mimeOf(c1)) } },
        ],
      },
    ],
    response_format: { type: "json_schema", json_schema: { name: "comparison", schema: comparisonSchema, strict: true } },
    ...extra,
  });
}
