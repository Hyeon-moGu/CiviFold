// Author: HyeonMo Gu
// Created: 2026-11-01

// The brief agent's terminal tool. A brief never decides: it lays out evidence for staff, and every item
// must cite a successful tool call of the run or a fact from its first message. Items that cite neither
// are deleted here, by the server, so nothing reaches staff on the model's word alone.
import { z } from "zod";
import type { Tool, ToolContext } from "./types";

export const BRIEF_SECTIONS = ["reported", "photos", "nearby", "history", "missing", "next"] as const;

const MAX_ITEMS = 12;

export const BriefItem = z
  .object({
    section: z.enum(BRIEF_SECTIONS),
    text: z.string().describe("One claim, one sentence"),
    evidence_refs: z.array(z.string()).describe('Refs that show it: tool results ("step_2") or facts from the first message ("fact_03")'),
  })
  .strict();

export const WriteBriefIn = z
  .object({
    summary: z.string().describe("At most two sentences: the state of the case for staff"),
    summary_refs: z.array(z.string()),
    items: z.array(BriefItem),
  })
  .strict();

export const WriteBriefOut = z
  .object({
    summary: z.object({ text: z.string(), evidence_refs: z.array(z.string()) }).strict().nullable(),
    items: z.array(BriefItem),
    kept: z.number(),
    dropped: z.number(),
  })
  .strict();

export type Brief = z.infer<typeof WriteBriefOut>;

export type Briefing = NonNullable<ToolContext["briefing"]>;

/** Keeps the refs that name a successful step or a known fact, and the items and summary left with one. */
export function cleanBrief(input: z.infer<typeof WriteBriefIn>, briefing: Briefing): Brief {
  const valid = new Set([...briefing.steps.filter((s) => s.ok).map((s) => s.ref), ...briefing.fact_refs]);
  const validRefs = (refs: string[]) => [...new Set(refs.filter((r) => valid.has(r)))];
  const items: Brief["items"] = [];
  let dropped = 0;
  for (const item of input.items) {
    const text = item.text.trim();
    const evidence_refs = validRefs(item.evidence_refs);
    if (text === "" || evidence_refs.length === 0 || items.length >= MAX_ITEMS) {
      dropped += 1;
      continue;
    }
    items.push({ section: item.section, text, evidence_refs });
  }
  const summaryText = input.summary.trim();
  const summaryRefs = validRefs(input.summary_refs);
  const summary = summaryText !== "" && summaryRefs.length > 0 ? { text: summaryText, evidence_refs: summaryRefs } : null;
  return { summary, items, kept: items.length, dropped };
}

export const writeBrief: Tool<typeof WriteBriefIn, typeof WriteBriefOut> = {
  name: "write_brief",
  description:
    "Write the case brief for staff. Every item needs at least one valid ref (a step_N tool result or a fact_NN " +
    "from the first message); items without one are deleted. Ends this run.",
  input: WriteBriefIn,
  output: WriteBriefOut,
  terminal: true,
  run: async (input, ctx) => {
    if (!ctx.briefing) throw new Error("write_brief runs only inside a brief");
    return cleanBrief(input, ctx.briefing);
  },
};
