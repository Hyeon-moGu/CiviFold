// Author: HyeonMo Gu
// Created: 2026-10-27

import { z } from "zod";
import { MissingItem, type Tool } from "./types";

export const AskResidentIn = z
  .object({
    question: z.string().describe("Max 200 characters, friendly, concrete, one request"),
    requested_items: z.array(MissingItem).describe("1–2 items"),
    reason_for_staff: z.string().describe("Why this is needed, one sentence"),
  })
  .strict();

export const AskResidentOut = z.object({ info_request_id: z.string(), status: z.literal("pending") }).strict();

export const askResident: Tool<typeof AskResidentIn, typeof AskResidentOut> = {
  name: "ask_resident",
  description:
    "Ask the resident for ONE specific piece of missing evidence and pause the investigation. " +
    "Use only when no tool can resolve the doubt. Ends this run.",
  input: AskResidentIn,
  output: AskResidentOut,
  terminal: true,
  // The question itself is stored by the caller from the agent run record; this tool only checks
  // that asking is still allowed and hands back the request id.
  run: async (input, ctx) => {
    if (!ctx.investigation) throw new Error("ask_resident runs only inside an investigation");
    if (ctx.investigation.base.report.already_asked) throw new Error("already_asked: the resident was asked once; propose HUMAN_REVIEW instead");
    if (input.requested_items.length === 0 || input.requested_items.length > 2) throw new Error("requested_items must hold 1 or 2 items");
    if (input.question.trim().length === 0 || input.question.length > 200) throw new Error("question must be 1–200 characters");
    return { info_request_id: `ir_${ctx.runId ?? ctx.reportId}`, status: "pending" as const };
  },
};
