// Author: HyeonMo Gu
// Created: 2026-10-27

// USD list prices. Spark output tokens include reasoning tokens.
const SPARK_PER_1M: Record<string, { input: number; output: number }> = {
  "muse-spark-1.3": { input: 1.25, output: 4.25 },
  "muse-spark-1.3-contributor": { input: 0.1, output: 0.2 },
  // No published price seen for 1.2; assumed equal to 1.3 so experiments are not under-counted.
  "muse-spark-1.2": { input: 1.25, output: 4.25 },
};

export const SAM_PER_IMAGE = 0.0025;
export const IMAGE_GEN_PER_IMAGE = 0.01;
// Billed per whole second of audio.
export const VOICE_PER_HOUR = 0.18;

export type TokenUsage = { input: number; output: number };

export function sparkCost(model: string, usage: TokenUsage | null): number {
  const price = SPARK_PER_1M[model];
  if (!price) throw new Error(`No price for ${model}`);
  if (!usage) return 0;
  return (usage.input * price.input + usage.output * price.output) / 1_000_000;
}

// What a live call holds against the daily budget until its real cost is known: above a typical call,
// so a budget is not overrun by calls in flight. Spark covers an agent turn; voice covers a minute.
const RESERVE: Record<string, number> = { "muse-spark-1.3": 0.05, "sam-3.1": SAM_PER_IMAGE, "muse-image-1.0": IMAGE_GEN_PER_IMAGE, "muse-voice-transcribe-1.0": 0.01 };

export const reserveFor = (model: string): number => RESERVE[model] ?? 0.05;
