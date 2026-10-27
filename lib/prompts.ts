// Author: HyeonMo Gu
// Created: 2026-10-27

import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";

export type PromptName = "triage" | "compare";

/** `hash` is the first 12 hex chars of the content's sha256, stored with each analysis. */
export type Prompt = { name: PromptName; text: string; hash: string };

const loaded = new Map<PromptName, Prompt>();

export async function loadPrompt(name: PromptName): Promise<Prompt> {
  const hit = loaded.get(name);
  if (hit) return hit;
  const text = (await readFile(path.join(process.cwd(), "prompts", `${name}.md`), "utf8")).trim();
  const prompt = { name, text, hash: createHash("sha256").update(text).digest("hex").slice(0, 12) };
  loaded.set(name, prompt);
  return prompt;
}
