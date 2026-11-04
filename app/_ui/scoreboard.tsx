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

// The SF 311 real-photo checks (eval/sf311/results.json and pairs-results.json), each run once with its picks and
// expectations written first. 13 requests came 1 hour to 7 days after Public Works' cleanup at the same spot (9 sets
// and 4 pairs); 33 pairs show the same pile or damage in both photos. Each world holds one earlier request at the
// spot, so location alone merges every same-problem pair and closes every request made after a cleanup.
export const REAL_SF = {
  afterCleanup: 13,
  samePairs: 33,
  location: { closed: 13, merged: 33 },
  civifold: { closed: 0, merged: 14, asked: 17, apart: 2, recurrence: 3 },
};

type Row = { measure: string; note: string; of: number; location: [number, string]; civifold: [number, string] };

// Two measures side by side, so each row compares the two ways at a glance. Compact leaves out the column notes,
// for a narrow column that says what each way is in its own text.
function Board({ rows, compact }: { rows: Row[]; compact: boolean }) {
  const cell = (n: number, total: number, tone: string) => (
    <td className="px-3 py-2.5 text-center">
      <span className={`text-2xl font-semibold tracking-tight sm:text-3xl ${tone}`}>{n}</span>
      <span className="ml-1 text-sm text-zinc-400">/ {total}</span>
    </td>
  );
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
        {rows.map((r, i) => (
          <tr key={r.measure} className={i > 0 ? "border-t border-zinc-100" : undefined}>
            <th scope="row" className="px-4 py-2.5 text-sm font-medium text-zinc-800">
              {r.measure}
              <span className="block text-xs font-normal text-zinc-500">{r.note}</span>
            </th>
            {cell(r.location[0], r.of, r.location[1])}
            {cell(r.civifold[0], r.of, r.civifold[1])}
          </tr>
        ))}
      </tbody>
    </table>
  );
}

/** The newest pre-registered held-out set of synthetic reports. */
export function Scoreboard({ compact = false }: { compact?: boolean }) {
  const { location: lo, civifold: cf } = HELD_OUT;
  return (
    <Board
      compact={compact}
      rows={[
        { measure: "Repeat reports merged into the right incident", note: "duplicates, and late reports seen before a repair", of: HELD_OUT.duplicates, location: [lo.right, "text-zinc-900"], civifold: [cf.right, "text-emerald-700"] },
        { measure: "Problems wrongly merged", note: "new or returning, should stay open", of: HELD_OUT.problems, location: [lo.wrong, "text-rose-700"], civifold: [cf.wrong, "text-emerald-700"] },
      ]}
    />
  );
}

/** The real San Francisco 311 photo checks. */
export function RealScoreboard({ compact = false }: { compact?: boolean }) {
  const { location: lo, civifold: cf } = REAL_SF;
  return (
    <Board
      compact={compact}
      rows={[
        { measure: "New trash after a cleanup, closed as fixed", note: "the same spot, should stay open", of: REAL_SF.afterCleanup, location: [lo.closed, "text-rose-700"], civifold: [cf.closed, "text-emerald-700"] },
        { measure: "Same pile or damage, merged", note: `CiviFold asked or sent ${REAL_SF.civifold.asked} to staff, kept ${REAL_SF.civifold.apart} apart`, of: REAL_SF.samePairs, location: [lo.merged, "text-zinc-900"], civifold: [cf.merged, "text-zinc-900"] },
      ]}
    />
  );
}
