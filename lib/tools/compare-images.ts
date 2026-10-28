// Author: HyeonMo Gu
// Created: 2026-10-27

import type OpenAI from "openai";
import { z } from "zod";
import { sparkJson } from "../meta/spark";
import { COMPARE_CONFIG } from "../pipeline/config";
import { loadPrompt } from "../prompts";
import { dataUrl, type ImageRow } from "./images";
import { DEFAULT_SAM_PROMPT, segmentObject } from "./segment-object";
import { CompareResult, ImageId, IncidentId, type Category, type ToolContext, type Tool } from "./types";

type Mode = "full" | "crops";
type Part = OpenAI.Chat.ChatCompletionContentPart;

export const CompareImagesIn = z
  .object({
    new_image_id: ImageId.describe("A photo of the report being investigated"),
    candidate_image_id: ImageId.describe("A photo from search_incidents or get_incident_timeline"),
    mode: z.enum(["full", "crops"]),
  })
  .strict();

export const CompareImagesOut = CompareResult.extend({
  candidate_incident_id: IncidentId.describe("Incident that owns candidate_image_id (resolved by the server)"),
  mode: z.enum(["full", "crops"]).describe("The mode actually used; crops falls back to full when SAM finds nothing"),
}).strict();

export const compareImages: Tool<typeof CompareImagesIn, typeof CompareImagesOut> = {
  name: "compare_images",
  description:
    "Visually compare the new report with one photo from a candidate incident. Returns whether it is " +
    "the same asset and whether the damage matches. mode 'crops' compares SAM object and context crops " +
    "(segments automatically if needed); 'full' compares the original photos.",
  input: CompareImagesIn,
  output: CompareImagesOut,
  run: async (input, ctx) => {
    const [fresh, candidate] = await Promise.all([ctx.images.get(input.new_image_id), ctx.images.get(input.candidate_image_id)]);
    if (!fresh) throw new Error(`Unknown image ${input.new_image_id}`);
    if (!candidate) throw new Error(`Unknown image ${input.candidate_image_id}`);
    // The result becomes evidence about this report, so the new side must be this report's photo (or its crop)
    // and the two sides must come from different photos.
    if (fresh.report_id !== ctx.reportId) throw new Error(`Image ${fresh.id} is not a photo of the report being investigated`);
    if (candidate.report_id === ctx.reportId) throw new Error(`Image ${candidate.id} is a photo of this report, not of an incident`);
    if ((fresh.source_image_id ?? fresh.id) === (candidate.source_image_id ?? candidate.id)) throw new Error("Both images come from the same photo");
    const incidentId = await ctx.images.incidentOf(candidate.id);
    if (!incidentId) throw new Error(`Image ${candidate.id} does not belong to an incident`);
    const category = (await ctx.images.triageOf(fresh.report_id))?.category ?? "other";

    let mode: Mode = input.mode;
    let images: Array<{ label: string; id: string }> = [];
    if (mode === "crops") {
      const [n, c] = await Promise.all([ensureCrops(fresh, category, ctx), ensureCrops(candidate, category, ctx)]);
      if (n && c) {
        images = [
          { label: "NEW report:\nIMAGE N1 — object crop", id: n.object },
          { label: "IMAGE N2 — context crop (wider area around the object)", id: n.context },
          { label: "CANDIDATE incident photo:\nIMAGE C1 — object crop", id: c.object },
          { label: "IMAGE C2 — context crop", id: c.context },
        ];
      } else {
        mode = "full";
      }
    }
    if (mode === "full") {
      images = [
        { label: "NEW report:\nIMAGE N1 — full photo", id: fresh.id },
        { label: "CANDIDATE incident photo:\nIMAGE C1 — full photo", id: candidate.id },
      ];
    }

    const prompt = await loadPrompt("compare");
    const parts: Part[] = [];
    for (const image of images) {
      const row = await ctx.images.get(image.id);
      parts.push({ type: "text", text: image.label });
      parts.push({ type: "image_url", image_url: { url: dataUrl(await ctx.images.bytes(image.id), row?.mime ?? "image/webp") } });
    }
    parts.push({ type: "text", text: `Asset category reported: ${category}` });

    const { data } = await sparkJson({
      name: "compare",
      schema: CompareResult,
      mode: ctx.mode,
      signal: ctx.signal,
      model: ctx.compareModel,
      messages: [
        { role: "system", content: prompt.text },
        { role: "user", content: parts },
      ],
    });
    return { ...requireDistinctiveEvidence(data), candidate_incident_id: incidentId, mode };
  },
};

// Crops from the image's latest segmentation, segmenting first with its report's SAM phrase if needed.
async function ensureCrops(image: ImageRow, category: Category, ctx: ToolContext): Promise<{ object: string; context: string } | null> {
  let seg = await ctx.images.latestSegmentation(image.id);
  if (!seg) {
    const phrase = (await ctx.images.triageOf(image.report_id))?.sam_prompt ?? DEFAULT_SAM_PROMPT[category];
    await segmentObject.run({ image_id: image.id, noun_phrase: phrase }, ctx);
    seg = await ctx.images.latestSegmentation(image.id);
  }
  return seg?.object_crop_id && seg.context_crop_id ? { object: seg.object_crop_id, context: seg.context_crop_id } : null;
}

// Generic features (a wall color, wet pavement) let the model call a close-up "same" with high confidence.
// Without enough distinctive evidence, "same" becomes "uncertain" and the resident is asked for a wider shot.
export function requireDistinctiveEvidence(result: CompareResult, config = COMPARE_CONFIG): CompareResult {
  const confidence = Math.min(1, Math.max(0, result.asset_match.confidence));
  const asset = { ...result.asset_match, confidence };
  if (asset.verdict !== "same" || asset.evidence.length >= config.min_same_evidence) return { ...result, asset_match: asset };
  return {
    ...result,
    asset_match: { ...asset, verdict: "uncertain", confidence: Math.min(confidence, config.weak_same_conf_cap) },
    missing_info: result.missing_info.length > 0 ? result.missing_info : ["wider_context"],
  };
}
