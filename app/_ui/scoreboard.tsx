// Author: HyeonMo Gu
// Created: 2026-11-03

import { SEARCH_CONFIG } from "@/lib/pipeline/config";

// holdout3, first run (eval/results/baseline_geo_holdout3_1.json and C_rules_holdout3_1.json): 39 base reports were
// duplicates or late reports to merge, and 33 were new or returning problems to keep open. A score on one side
// alone says little: a system that never merges makes no wrong merge. "right" counts merges into the right incident
// whatever the label: location alone calls a late report a duplicate, and merges it all the same.
export const HELD_OUT = {
  duplicates: 39,
  problems: 33,
  location: { right: 30, wrong: 24, wrongIncident: 8 },
  civifold: { right: 34, wrong: 0, afterQuestion: 14 }, // 12 answered with a photo, 2 with the time it was seen
};

// The same two measures side by side, so each row compares the two ways at a glance. Compact leaves out the column
// notes, for a narrow column that says what each way is in its own text.
export function Scoreboard({ compact = false }: { compact?: boolean }) {
  const cell = (n: number, of: number, tone: string) => (
    <td className="px-3 py-2.5 text-center">
      <span className={`text-2xl font-semibold tracking-tight sm:text-3xl ${tone}`}>{n}</span>
      <span className="ml-1 text-sm text-zinc-400">/ {of}</span>
    </td>
  );
  const { location: lo, civifold: cf } = HELD_OUT;
  return (
    <table className="w-full text-left">
      <colgroup>
        <col />
        <col className={compact ? "w-24 sm:w-36" : "w-28 sm:w-56"} />
        <col className={compact ? "w-24 sm:w-36" : "w-28 sm:w-56"} />
      </colgroup>
      <thead>
        <tr className="align-bottom">
          <th className="px-4 pt-3">
            <span className="sr-only">Measure</span>
          </th>
          <th className="px-3 pt-3 text-center text-sm font-medium text-zinc-600">
            Location alone
            {!compact && <span className="hidden text-[11px] font-normal text-zinc-400 sm:block">nearest of the same kind, {SEARCH_CONFIG.radius_m.fire_hydrant} m</span>}
          </th>
          <th className="px-3 pt-3 text-center text-sm font-semibold text-zinc-900">
            CiviFold
            {!compact && <span className="hidden text-[11px] font-normal text-zinc-400 sm:block">photos, Muse Spark and SAM 3.1</span>}
          </th>
        </tr>
      </thead>
      <tbody>
        <tr>
          <th scope="row" className="px-4 py-2.5 text-sm font-medium text-zinc-800">
            Repeat reports merged into the right incident
            <span className="block text-xs font-normal text-zinc-500">duplicates, and late reports seen before a repair</span>
          </th>
          {cell(lo.right, HELD_OUT.duplicates, "text-zinc-900")}
          {cell(cf.right, HELD_OUT.duplicates, "text-emerald-700")}
        </tr>
        <tr className="border-t border-zinc-100">
          <th scope="row" className="px-4 py-2.5 text-sm font-medium text-zinc-800">
            Problems wrongly merged
            <span className="block text-xs font-normal text-zinc-500">new or returning, should stay open</span>
          </th>
          {cell(lo.wrong, HELD_OUT.problems, "text-rose-700")}
          {cell(cf.wrong, HELD_OUT.problems, "text-emerald-700")}
        </tr>
      </tbody>
    </table>
  );
}
