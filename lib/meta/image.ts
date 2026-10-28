// Author: HyeonMo Gu
// Created: 2026-10-27

import { createHash } from "node:crypto";
import { toFile } from "openai";
import { metaCall, type CallInfo, type Mode } from "./call";
import { meta, MODELS } from "./client";
import { IMAGE_GEN_PER_IMAGE } from "./pricing";
import { RetryableError } from "./retry";

type ImageResponse = { data?: Array<{ b64_json?: string }> };

export type ImageSize = "1536x1024" | "1024x1536";

// Muse Image returns webp at a larger size than requested (1536x1024 → 1920x1280), keeping the aspect ratio.
const OPTIONS = { output_format: "webp", reasoning_strength: "high" } as const;

export async function generateImage(prompt: string, opts: { size?: ImageSize; mode?: Mode } = {}) {
  const request = { model: MODELS.image, prompt, n: 1, size: opts.size ?? "1536x1024", ...OPTIONS };
  return run(request, () => meta().images.generate(request as never) as Promise<ImageResponse>, opts.mode);
}

/** Edits `input`. The cache key holds the input's hash rather than its bytes. */
export async function editImage(input: Buffer, prompt: string, opts: { size?: ImageSize; mode?: Mode } = {}) {
  const params = { model: MODELS.image, prompt, size: opts.size ?? "1536x1024", ...OPTIONS };
  const key = { ...params, input_sha256: createHash("sha256").update(input).digest("hex") };
  const send = async () => {
    const image = await toFile(input, "input.webp", { type: "image/webp" });
    return meta().images.edit({ ...params, image } as never) as Promise<ImageResponse>;
  };
  return run(key, send, opts.mode);
}

async function run(key: unknown, send: () => Promise<ImageResponse>, mode?: Mode): Promise<{ bytes: Buffer; call: CallInfo }> {
  const { response, call } = await metaCall<ImageResponse>({
    model: MODELS.image,
    request: key,
    mode,
    send,
    cost: () => IMAGE_GEN_PER_IMAGE,
    validate: (res) => {
      if (!res.data?.[0]?.b64_json) throw new RetryableError("Muse Image returned no image");
    },
  });
  return { bytes: Buffer.from(response.data![0]!.b64_json!, "base64"), call };
}
