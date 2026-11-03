// Author: HyeonMo Gu
// Created: 2026-10-27

// Runs one pipeline configuration over a split of dataset/cases.json and writes eval/results/.
// Usage: npm run eval -- --config C_rules --split dev [--set base|stress|all] [--run 1] [--only H1-t2,W5-lookalike-open]
// Tune only on dev. A repeat run for variance needs CIVIFOLD_MODE=live, or the cache replays the first run.
import { createHash } from "node:crypto";
import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import { parseArgs } from "node:util";
import sharp from "sharp";
import { imageId, loadAssets } from "../lib/dataset/assets";
import type { Case } from "../lib/eval/cases";
import { summarize } from "../lib/eval/metrics";
import { CONFIGS, evaluateCase, type CaseResult, type Config, type LoadImage } from "../lib/eval/run";
import { defaultMode } from "../lib/meta/call";
import { loadPrompt } from "../lib/prompts";

const CONCURRENCY = 4;

async function main() {
  const { values } = parseArgs({
    options: { config: { type: "string", default: "C_rules" }, split: { type: "string", default: "dev" }, set: { type: "string", default: "all" }, run: { type: "string", default: "1" }, only: { type: "string" } },
  });
  if (!CONFIGS.includes(values.config as Config)) throw new Error(`Unknown config ${values.config}; available: ${CONFIGS.join(", ")}`);
  // The current holdout stays unseen while the rules change: it runs once, on purpose, at the end.
  if ((values.split === "holdout2" || values.split === "holdout3") && process.env.HOLDOUT_FINAL_RUN !== "yes") throw new Error("The holdout is locked. Set HOLDOUT_FINAL_RUN=yes for the one final run.");
  // Only assets whose images exist enter the replayed world (e.g. test images not generated yet).
  // Every asset sits at least 100 m from the others' search radius, so leaving one out changes no candidate list.
  const loaded = await loadAssets();
  const exists = (id: string) => access(`dataset/images/${id}.webp`).then(() => true, () => false);
  const present = await Promise.all(loaded.assets.map((a) => exists(imageId(a.id, "damaged_v1", "front"))));
  const file = { ...loaded, assets: loaded.assets.filter((_, i) => present[i]) };
  const all = JSON.parse(await readFile("dataset/cases.json", "utf8")) as Case[];
  const only = values.only?.split(",");
  const cases = all.filter((c) => c.split === values.split && (values.set === "all" || c.set === values.set) && (!only || only.includes(c.id)));
  const mode = defaultMode();

  const images = new Map<string, ReturnType<LoadImage>>();
  const loadImage: LoadImage = (id) => {
    let hit = images.get(id);
    if (!hit) {
      hit = readFile(`dataset/images/${id}.webp`).then(async (bytes) => {
        const { width = 0, height = 0 } = await sharp(bytes).metadata();
        return { bytes, width, height, mime: "image/webp" };
      });
      images.set(id, hit);
    }
    return hit;
  };

  const results: CaseResult[] = [];
  const queue = [...cases];
  await Promise.all(
    Array.from({ length: CONCURRENCY }, async () => {
      for (let c = queue.shift(); c; c = queue.shift()) {
        try {
          const r = await evaluateCase(c, file, loadImage, mode, values.config as Config);
          results.push(r);
          const mark = { correct: "✓", deferred: "·", safe_error: "~", critical: "✗" }[r.outcome];
          const agent = r.agent_runs.map((a) => ` agent:${a.status}[${a.tools.join(">")}]${a.blocked_rules.length ? ` blocked ${a.blocked_rules.join(",")}` : ""}`).join("");
          console.log(`${mark} ${c.id.padEnd(26)} expected ${c.expected.label}${c.expected.incident ? ` ${c.expected.incident}` : ""} → ${r.predicted.label}${r.predicted.incident ? ` ${r.predicted.incident}` : ""} [${r.predicted.rule_id}]${r.asked ? ` (asked ${r.asked})` : ""}${agent}`);
        } catch (err) {
          console.log(`! ${c.id}: ${String(err).slice(0, 300)}`);
        }
      }
    }),
  );
  const out = `eval/results/${values.config}_${values.split}_${values.run}.json`;
  // --only re-runs a few cases (say, after a transient API error) into an existing run instead of replacing it.
  if (only) {
    const earlier = await readFile(out, "utf8").then((t) => (JSON.parse(t) as { results: CaseResult[] }).results, () => [] as CaseResult[]);
    const redone = new Set(results.map((r) => r.case_id));
    results.push(...earlier.filter((r) => !redone.has(r.case_id)));
  }
  results.sort((a, b) => a.case_id.localeCompare(b.case_id));

  const summary = summarize(results.filter((r) => r.set === "base"));
  const stressSummary = summarize(results.filter((r) => r.set === "stress"));
  await mkdir("eval/results", { recursive: true });
  await writeFile(
    out,
    JSON.stringify(
      {
        config: values.config,
        split: values.split,
        run: Number(values.run),
        mode,
        prompt_hash: { triage: (await loadPrompt("triage")).hash, compare: (await loadPrompt("compare")).hash, locate: (await loadPrompt("locate")).hash, agent: (await loadPrompt("agent")).hash },
        code_hash: await codeHash(),
        created_at: new Date().toISOString(),
        failed_cases: only ? undefined : cases.length - results.length,
        summary,
        stress_summary: stressSummary,
        results,
      },
      null,
      2,
    ) + "\n",
  );
  console.log(
    `\n${results.length}/${cases.length} cases · base: critical ${summary.outcomes.critical}, deferred ${summary.outcomes.deferred}` +
      ` · stress: critical ${stressSummary.outcomes.critical}, deferred ${stressSummary.outcomes.deferred} → ${out}`,
  );
}

// The decision code a run used, so a result file shows whether the rules changed since (they are frozen for test).
const DECISION_CODE = ["lib/pipeline/decide.ts", "lib/pipeline/config.ts", "lib/pipeline/analyze.ts", "lib/pipeline/hybrid.ts", "lib/pipeline/guard.ts", "lib/agent/run.ts", "lib/eval/ablations.ts"];

async function codeHash(): Promise<string> {
  const hash = createHash("sha256");
  for (const file of DECISION_CODE) hash.update(await readFile(file));
  return hash.digest("hex").slice(0, 12);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
