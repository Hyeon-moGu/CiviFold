// Author: HyeonMo Gu
// Created: 2026-10-27

import { parseImageStream, recordsOfKind, type ResponsesEvent } from "@meta-sam/parser";
import { metaCall, type CallInfo, type Mode } from "./call";
import { metaPost, MODELS } from "./client";
import { SAM_PER_IMAGE } from "./pricing";

type SamResponse = {
  status: string;
  output?: Array<{ id?: string; content?: Array<{ type: string; text?: string }> }>;
};

/**
 * Segments every instance of `phrase` in one image (URL or data URL).
 * Mask rasters of large objects come back downscaled: map a mask to the frame with
 * scale(bounds width / mask.width, bounds height / mask.height), then translate(bounds.left, bounds.top).
 */
export async function segment(image: string, phrase: string, opts: { mode?: Mode } = {}) {
  // SAM takes one noun phrase; a list ("hydrant and pole") is not split into two prompts.
  if (/,|\b(and|or)\b/i.test(phrase)) throw new Error(`SAM phrase must be a single noun phrase, got "${phrase}"`);
  // Image requests must be unary: a streaming image request fails upstream.
  const request = {
    model: MODELS.sam,
    stream: false,
    input: [
      {
        type: "message",
        role: "user",
        content: [
          { type: "input_text", text: phrase },
          { type: "input_image", image_url: image },
        ],
      },
    ],
    metadata: { include_confidence: "true" },
  };
  const { response, call } = await metaCall<SamResponse>({
    model: MODELS.sam,
    request,
    mode: opts.mode,
    send: () => metaPost<SamResponse>("responses", request),
    cost: () => SAM_PER_IMAGE,
  });
  const result = await parseImageStream(toEvents(response)).finalResult;
  return {
    boxes: recordsOfKind(result.records, "box"),
    masks: recordsOfKind(result.records, "mask"),
    diagnostics: result.diagnostics,
    call: call satisfies CallInfo,
  };
}

// The parser consumes a Responses event stream; replay the unary JSON body as one.
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
