// Author: HyeonMo Gu
// Created: 2026-10-27

import { metaCall, type CallInfo, type Mode } from "./call";
import { metaPost, MODELS } from "./client";
import { sparkCost } from "./pricing";
import { replayForm } from "./replay";
import { RetryableError } from "./retry";

export type ResponseItem = { type: string; [key: string]: unknown };
export type FunctionCall = { type: "function_call"; name: string; arguments: string; call_id: string };

type ResponsesBody = {
  status: string;
  output?: ResponseItem[];
  usage?: { input_tokens: number; output_tokens: number };
};

// Only tool_choice "auto" is supported: a step that must end the run can only narrow the tool list.
export async function sparkRespond(opts: { input: unknown[]; tools: unknown[]; mode?: Mode; model?: string; signal?: AbortSignal }): Promise<{ output: ResponseItem[]; call: CallInfo }> {
  const model = opts.model ?? MODELS.spark;
  const request = { model, input: opts.input, tools: opts.tools, tool_choice: "auto", reasoning: { effort: "medium" } };
  const { response, call } = await metaCall<ResponsesBody>({
    model,
    request,
    mode: opts.mode,
    replay: replayForm<ResponsesBody>(request),
    send: () => metaPost<ResponsesBody>("responses", request, opts.signal),
    cost: (res) => sparkCost(model, res.usage ? { input: res.usage.input_tokens, output: res.usage.output_tokens } : null),
    validate: (res) => {
      if (res.status !== "completed") throw new RetryableError(`Responses API status ${res.status}`);
    },
  });
  return { output: response.output ?? [], call };
}

export const functionCalls = (output: ResponseItem[]): FunctionCall[] =>
  output.filter((o): o is FunctionCall => o.type === "function_call" && typeof o.name === "string" && typeof o.call_id === "string");
