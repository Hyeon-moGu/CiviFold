// Author: HyeonMo Gu
// Created: 2026-10-27

// USD list prices. Spark output tokens include reasoning tokens.
const SPARK_PER_1M: Record<string, { input: number; output: number }> = {
  "muse-spark-1.3": { input: 1.25, output: 4.25 },
  "muse-spark-1.3-contributor": { input: 0.1, output: 0.2 },
};

export const SAM_PER_IMAGE = 0.0025;
export const IMAGE_GEN_PER_IMAGE = 0.01;

export type TokenUsage = { input: number; output: number };

export function sparkCost(model: string, usage: TokenUsage | null): number {
  const price = SPARK_PER_1M[model];
  if (!price) throw new Error(`No price for ${model}`);
  if (!usage) return 0;
  return (usage.input * price.input + usage.output * price.output) / 1_000_000;
}
