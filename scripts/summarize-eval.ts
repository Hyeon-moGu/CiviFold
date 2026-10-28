// Author: HyeonMo Gu
// Created: 2026-10-27

// Collects eval/results/*.json into eval/summary.json and prints the metrics table as Markdown.
// Summaries are recomputed from the per-case results, so new metrics apply to earlier runs too.
// Usage: npm run summarize-eval -- [--split test]
import { readdir, readFile, writeFile } from "node:fs/promises";
import { parseArgs } from "node:util";
import { summarize, type ScoredCase } from "../lib/eval/metrics";

type ResultFile = {
  config: string;
  split: string;
  run: number;
  results: Array<ScoredCase & { case_id: string; set?: "base" | "stress"; predicted: { rule_id: string } }>;
};

const pct = (x: number | null) => (x === null ? "n/a" : `${(x * 100).toFixed(1)}%`);

async function main() {
  const { values } = parseArgs({ options: { split: { type: "string", default: "dev" } } });
  const files = (await readdir("eval/results")).filter((f) => f.endsWith(".json"));
  const runs = await Promise.all(files.map(async (f) => JSON.parse(await readFile(`eval/results/${f}`, "utf8")) as ResultFile));
  const chosen = runs.filter((r) => r.split === values.split).sort((a, b) => a.config.localeCompare(b.config) || a.run - b.run);

  const lines = [
    `| Config | Set | Run | Cases | Critical miss ↓ | Review reduction ↑ | Dup precision | Dup recall | Staff review (all answer → none answer) | Asked | $/report | s/report |`,
    `|---|---|---|---|---|---|---|---|---|---|---|---|`,
    ...chosen.flatMap(({ config, run, results }) =>
      (["base", "stress"] as const).map((set) => [set, summarize(results.filter((r) => (r.set ?? "base") === set))] as const).flatMap(([set, s]) =>
        s.cases > 0
          ? [
              `| ${config} | ${set} | ${run} | ${s.cases} | ${pct(s.critical_miss_rate)} (${s.outcomes.critical}) | ${pct(s.review_reduction)} | ${pct(s.dup_precision)} | ${pct(s.dup_recall)} | ${pct(s.deferral_rate)} → ${pct(s.staff_review_if_no_answer)} | ${pct(s.question_rate)} | $${(s.usd_per_report ?? 0).toFixed(3)} | ${(s.seconds_per_report ?? 0).toFixed(1)} |`,
            ]
          : [],
      ),
    ),
  ];
  lines.push(
    "",
    "**Base set by stage** (an asked report is deferred until answered, and goes to staff if nobody answers)",
    "",
    "| Config | Run | First decision = nobody answers: correct · deferred · critical (miss rate) | After answers: correct · deferred · critical (miss rate) | Asked → correct · still deferred · safe error · critical |",
    "|---|---|---|---|---|",
    ...chosen.map(({ config, run, results }) => {
      const { first_or_no_answer: f, after_answer: a, asked, answer_effect: e } = summarize(results.filter((r) => (r.set ?? "base") === "base")).stages;
      return `| ${config} | ${run} | ${f.correct} · ${f.deferred} · ${f.critical} (${pct(f.critical_miss_rate)}) | ${a.correct} · ${a.deferred} · ${a.critical} (${pct(a.critical_miss_rate)}) | ${asked} → ${e.correct} · ${e.still_deferred} · ${e.safe_error} · ${e.critical} |`;
    }),
  );
  for (const { config, run, results } of chosen) {
    const misses = results.filter((r) => r.outcome !== "correct");
    if (misses.length === 0) continue;
    lines.push("", `**${config} run ${run}: not correct**`, "");
    for (const r of misses) lines.push(`- ${r.outcome} · ${r.case_id}: expected ${r.expected.label}, got ${r.predicted.label} [${r.predicted.rule_id}]`);
  }
  console.log(lines.join("\n"));
  await writeFile(
    "eval/summary.json",
    JSON.stringify(
      chosen.map(({ config, split, run, results }) => ({
        config,
        split,
        run,
        summary: summarize(results.filter((r) => (r.set ?? "base") === "base")),
        stress_summary: summarize(results.filter((r) => r.set === "stress")),
      })),
      null,
      2,
    ) + "\n",
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
