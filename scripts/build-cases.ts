// Author: HyeonMo Gu
// Created: 2026-10-27

// Writes dataset/cases.json: every report the evaluation submits, with its answer key.
import { writeFile } from "node:fs/promises";
import { loadAssets } from "../lib/dataset/assets";
import { buildCases } from "../lib/eval/cases";

async function main() {
  const cases = buildCases(await loadAssets());
  await writeFile("dataset/cases.json", JSON.stringify(cases, null, 2) + "\n");
  const count = (split: string) => cases.filter((c) => c.split === split).length;
  console.log(`${cases.length} cases (dev ${count("dev")}, val ${count("val")}, test ${count("test")}, holdout ${count("holdout")}, holdout2 ${count("holdout2")}, holdout3 ${count("holdout3")}) → dataset/cases.json`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
