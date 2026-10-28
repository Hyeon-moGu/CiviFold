// Author: HyeonMo Gu
// Created: 2026-10-27

import { z } from "zod";
import type { CallInfo } from "../meta/call";
import { sparkJson } from "../meta/spark";
import { loadPrompt } from "../prompts";
import { Category, type Channel, type ToolContext } from "../tools/types";

// What a resident's words say, before any photo is read. Text only: no photo, no time rules.
export const IntakeResult = z
  .object({
    emergency: z.boolean(),
    emergency_reason: z.string().nullable(),
    out_of_scope: z.boolean(),
    category: Category,
    problem: z.string().nullable(),
    place: z.string().nullable(),
    landmarks: z.array(z.string()),
    observed_time: z.string().nullable(),
  })
  .strict();

export type IntakeResult = z.infer<typeof IntakeResult>;

const MAX_LANDMARKS = 4;

export async function readIntake(text: string, ctx: Pick<ToolContext, "mode">): Promise<{ result: IntakeResult; call: CallInfo; prompt_hash: string }> {
  const prompt = await loadPrompt("intake");
  const { data, call } = await sparkJson({
    name: "intake",
    schema: IntakeResult,
    mode: ctx.mode,
    messages: [
      { role: "system", content: prompt.text },
      { role: "user", content: `Resident message:\n"""\n${text}\n"""` },
    ],
  });
  return { result: { ...data, landmarks: data.landmarks.slice(0, MAX_LANDMARKS) }, call, prompt_hash: prompt.hash };
}

/** The channel follows from what was attached. A recording outranks typed text: it is what the resident said. */
export function channelOf(input: { photo: boolean; text: boolean; voice: boolean }): Channel {
  if (input.voice) return input.photo ? "voice_photo" : "voice";
  if (input.photo) return input.text ? "photo_text" : "photo";
  return "text";
}

/** The words the pipeline reads: what the resident typed and what they said. */
export function messageText(description: string | null, transcript: string | null): string | null {
  const parts = [description, transcript].map((p) => p?.trim()).filter((p): p is string => Boolean(p));
  return parts.length > 0 ? parts.join("\n") : null;
}
