// Author: HyeonMo Gu
// Created: 2026-10-27

import type OpenAI from "openai";
import type { z } from "zod";
import { jsonSchemaFormat } from "../tools/json-schema";
import { metaCall, type CallInfo, type Mode } from "./call";
import { meta, MODELS } from "./client";
import { sparkCost } from "./pricing";
import { RetryableError } from "./retry";

type Completion = OpenAI.Chat.ChatCompletion;

/** One strict-JSON chat completion, validated against `schema`. */
export async function sparkJson<S extends z.ZodType>(opts: {
  name: string;
  schema: S;
  messages: OpenAI.Chat.ChatCompletionMessageParam[];
  model?: string;
  temperature?: number;
  mode?: Mode;
  signal?: AbortSignal;
}): Promise<{ data: z.infer<S>; call: CallInfo }> {
  const model = opts.model ?? MODELS.spark;
  const request = {
    model,
    messages: opts.messages,
    temperature: opts.temperature ?? 0,
    response_format: jsonSchemaFormat(opts.name, opts.schema),
  };
  const { response, call } = await metaCall<Completion>({
    model,
    request,
    mode: opts.mode,
    send: () => meta().chat.completions.create(request, { signal: opts.signal }),
    cost: (res) => sparkCost(model, res.usage ? { input: res.usage.prompt_tokens, output: res.usage.completion_tokens } : null),
    validate: (res) => void parseCompletion(res, opts.schema),
  });
  return { data: parseCompletion(response, opts.schema), call };
}

// Spark is a reasoning model: reasoning tokens count against max_tokens, so a long think can
// end with finish_reason "length" and no content.
export function parseCompletion<S extends z.ZodType>(res: Completion, schema: S): z.infer<S> {
  const choice = res.choices[0];
  if (choice?.finish_reason === "length") throw new RetryableError("Spark hit the token limit before answering");
  const content = choice?.message.content;
  if (!content) throw new RetryableError("Spark returned no content");
  let json: unknown;
  try {
    json = JSON.parse(content);
  } catch {
    throw new RetryableError(`Spark returned invalid JSON: ${content.slice(0, 200)}`);
  }
  const parsed = schema.safeParse(json);
  if (!parsed.success) throw new RetryableError(`Spark output failed the schema: ${parsed.error.message.slice(0, 400)}`);
  return parsed.data;
}
