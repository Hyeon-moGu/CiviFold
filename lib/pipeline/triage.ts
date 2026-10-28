// Author: HyeonMo Gu
// Created: 2026-10-27

import { z } from "zod";
import type { CallInfo } from "../meta/call";
import { sparkJson } from "../meta/spark";
import { loadPrompt } from "../prompts";
import { dataUrl } from "../tools/images";
import { checkNounPhrase, DEFAULT_SAM_PROMPT } from "../tools/segment-object";
import { Category, type ToolContext } from "../tools/types";

export const TriageResult = z
  .object({
    out_of_scope: z.boolean(),
    category: Category,
    sam_prompt: z.string(),
    damage_present: z.boolean(),
    damage_description: z.string().nullable(),
    repair_signs: z.boolean(),
    context_landmarks: z.array(z.string()),
    image_quality: z.enum(["ok", "blurry", "object_not_visible", "too_far"]),
    severity: z.enum(["low", "medium", "high"]),
  })
  .strict();

export type TriageResult = z.infer<typeof TriageResult>;

// Accepted SAM phrases per category; anything else falls back to the default.
const ALLOWED_SAM_PROMPTS: Record<Category, readonly string[]> = {
  fire_hydrant: ["fire hydrant", "hydrant"],
  streetlight: ["street light", "streetlight", "street lamp", "street light pole", "light pole", "lamp post"],
  traffic_sign: ["traffic sign", "road sign", "street sign", "stop sign", "yield sign", "sign"],
  bench: ["bench", "park bench"],
  road_damage: ["pothole", "road crack", "crack", "broken pavement", "sidewalk crack"],
  trash: ["trash", "garbage", "trash pile", "garbage bags", "trash bags", "litter", "trash bin", "mattress"],
  graffiti: ["graffiti", "spray paint"],
  other: [],
};

const MAX_LANDMARKS = 4;

/** Scope, category, SAM phrase, problem and photo quality for one resident photo. No time information goes in. */
export async function triage(
  imageId: string,
  report: { description: string | null; category_hint: string | null },
  ctx: Pick<ToolContext, "images" | "mode">,
): Promise<{ result: TriageResult; call: CallInfo; prompt_hash: string }> {
  const [prompt, image, bytes] = await Promise.all([loadPrompt("triage"), ctx.images.get(imageId), ctx.images.bytes(imageId)]);
  if (!image) throw new Error(`Unknown image ${imageId}`);
  const { data, call } = await sparkJson({
    name: "triage",
    schema: TriageResult,
    mode: ctx.mode,
    messages: [
      { role: "system", content: prompt.text },
      {
        role: "user",
        content: [
          { type: "text", text: "IMAGE R1 — resident photo" },
          { type: "image_url", image_url: { url: dataUrl(bytes, image.mime) } },
          { type: "text", text: `Optional resident note: "${report.description ?? "none"}"` },
          { type: "text", text: `Optional resident category hint: "${report.category_hint ?? "none"}"` },
        ],
      },
    ],
  });
  return { result: normalizeTriage(data), call, prompt_hash: prompt.hash };
}

export function normalizeTriage(r: TriageResult): TriageResult {
  const phrase = r.sam_prompt.trim().toLowerCase();
  const allowed =
    r.category === "other"
      ? checkNounPhrase(phrase) === null && phrase.split(/\s+/).length <= 3
      : ALLOWED_SAM_PROMPTS[r.category].includes(phrase);
  return {
    ...r,
    sam_prompt: allowed ? phrase : DEFAULT_SAM_PROMPT[r.category],
    context_landmarks: r.context_landmarks.slice(0, MAX_LANDMARKS),
  };
}
