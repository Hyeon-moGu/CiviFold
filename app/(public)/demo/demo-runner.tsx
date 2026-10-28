// Author: HyeonMo Gu
// Created: 2026-10-27

"use client";

import Link from "next/link";
import { useState } from "react";
import type { Label } from "@/lib/tools/types";
import { LabelBadge, UrgentBadge } from "@/app/_ui/labels";

type ScenarioView = { id: string; title: string; story: string; steps: Array<{ text: string; expect: Label | null; urgent: boolean }> };
type StepResult = { report_id?: string; tracking_code?: string; status?: string; error?: string; done?: string };

export function DemoRunner({ scenarios }: { scenarios: ScenarioView[] }) {
  const [results, setResults] = useState<Record<string, StepResult>>({});
  const [busy, setBusy] = useState<string | null>(null);
  const [resetDone, setResetDone] = useState(false);

  async function reset() {
    setBusy("reset");
    await fetch("/api/demo/reset", { method: "POST" });
    setResults({});
    setResetDone(true);
    setBusy(null);
  }

  async function run(scenario: string, step: number) {
    const key = `${scenario}:${step}`;
    setBusy(key);
    const res = await fetch("/api/demo/step", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ scenario, step }) });
    const body = (await res.json()) as StepResult;
    setResults((r) => ({ ...r, [key]: res.ok ? body : { error: body.error ?? "Failed." } }));
    setBusy(null);
  }

  return (
    <div className="mt-8 space-y-5">
      <div className="sticky top-[57px] z-10 -mx-4 flex flex-wrap items-center gap-3 border-b border-zinc-200 bg-white/95 px-4 py-3 backdrop-blur sm:static sm:mx-0 sm:rounded-xl sm:border sm:px-4">
        <button onClick={reset} disabled={busy !== null} className="rounded-lg bg-zinc-900 px-4 py-2 text-sm font-semibold text-white hover:bg-zinc-800 disabled:opacity-50">
          {busy === "reset" ? "Resetting…" : "Reset the demo"}
        </button>
        <span className="text-sm text-zinc-500">{resetDone ? <span className="text-emerald-700">Back to the starting state.</span> : "Start here, so every scenario begins the same way."}</span>
        <Link href="/admin" className="ml-auto text-sm font-medium text-zinc-900 underline underline-offset-2">
          Staff console →
        </Link>
      </div>

      {scenarios.map((sc, n) => (
        <section key={sc.id} className="rounded-2xl border border-zinc-200 p-5">
          <div className="flex items-baseline gap-3">
            <span className="font-mono text-xs text-zinc-400">{String(n + 1).padStart(2, "0")}</span>
            <h2 className="font-semibold">{sc.title}</h2>
          </div>
          <p className="mt-1.5 text-sm text-zinc-600">{sc.story}</p>
          <ol className="mt-4 divide-y divide-zinc-100 rounded-xl border border-zinc-200">
            {sc.steps.map((st, i) => {
              const key = `${sc.id}:${i}`;
              const r = results[key];
              const ran = Boolean(r && !r.error);
              return (
                <li key={key} className="flex flex-wrap items-center gap-x-3 gap-y-2 px-3 py-2.5">
                  <span className={`flex h-6 w-6 shrink-0 items-center justify-center rounded-full text-[11px] font-semibold ${ran ? "bg-zinc-900 text-white" : "bg-zinc-100 text-zinc-500"}`}>
                    {ran ? "✓" : i + 1}
                  </span>
                  <button
                    onClick={() => run(sc.id, i)}
                    disabled={busy !== null}
                    className="rounded-lg border border-zinc-300 px-3 py-1.5 text-left text-sm hover:border-zinc-400 hover:bg-zinc-50 disabled:opacity-50"
                  >
                    {busy === key ? "Running…" : st.text}
                  </button>
                  {st.expect && (
                    <span className="flex items-center gap-1 text-xs text-zinc-500">
                      expected {st.urgent && <UrgentBadge />} <LabelBadge label={st.expect} />
                    </span>
                  )}
                  {r?.error && <span className="w-full text-sm text-rose-700 sm:w-auto">{r.error}</span>}
                  {r?.done && <span className="text-sm text-emerald-700">Done.</span>}
                  {r?.report_id && (
                    <span className="flex w-full gap-3 pl-9 text-sm sm:ml-auto sm:w-auto sm:pl-0">
                      <Link href={`/admin/reports/${r.report_id}`} className="font-medium text-zinc-900 underline underline-offset-2">
                        Staff view
                      </Link>
                      <Link href={`/track/${r.tracking_code}`} className="text-zinc-900 underline underline-offset-2">
                        Resident view
                      </Link>
                    </span>
                  )}
                </li>
              );
            })}
          </ol>
        </section>
      ))}
    </div>
  );
}
