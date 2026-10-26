// Author: HyeonMo Gu
// Created: 2026-10-27

// Muse Spark smoke test: two labeled images, strict json_schema output with a nullable field, temperature 0.
// Needs .cache/smoke/h1-front.webp and h1-left45.webp from `npm run smoke:image`.
import { Comparison, compare, comparisonSchema } from "./compare";
import { load, timed } from "./common";

async function main() {
  console.log("JSON schema sent:", JSON.stringify(comparisonSchema));
  const front = await load("h1-front.webp");
  const left = await load("h1-left45.webp");

  let res;
  try {
    res = await timed("compare front vs left45 (temperature 0)", () => compare(front, left));
    console.log("  temperature: accepted");
  } catch (err) {
    console.log(`  temperature rejected → retry without it\n  ${String(err).slice(0, 400)}`);
    res = await timed("compare front vs left45", () => compare(front, left, {}));
  }

  const choice = res.choices[0];
  console.log("  finish_reason:", choice?.finish_reason, "| usage:", JSON.stringify(res.usage));
  const raw = choice?.message.content ?? "";
  const parsed = Comparison.safeParse(JSON.parse(raw || "null"));
  console.log("  schema valid:", parsed.success);
  console.log(JSON.stringify(parsed.success ? parsed.data : raw, null, 2));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
