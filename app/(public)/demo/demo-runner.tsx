// Author: HyeonMo Gu
// Created: 2026-10-27

"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import type { Label } from "@/lib/tools/types";
import { LabelBadge, SyntheticBadge, UrgentBadge } from "@/app/_ui/labels";

type StepView = {
  kind: "repair" | "report" | "message" | "answer" | "verify" | "brief";
  text: string;
  why: string;
  expect: Label | null;
  urgent: boolean;
  photo?: string;
  message?: { kind: "voice" | "text"; text: string; audio: string | null };
};
export type ScenarioView = { id: string; title: string; story: string; world: Array<{ title: string; photo: string }>; steps: StepView[] };
type StepResult = { report_id?: string; tracking_code?: string; label?: Label; brief?: { status: string; kept: number; dropped: number }; error?: string; done?: string };

const ACTION: Record<StepView["kind"], string> = {
  repair: "Record it",
  report: "Send this report",
  message: "Send this message",
  answer: "Send the answer",
  verify: "Run the check",
  brief: "Write the brief",
};

function Thumb({ src, alt }: { src: string; alt: string }) {
  return (
    <div className="relative overflow-hidden rounded-lg border border-zinc-200 bg-zinc-100">
      {/* eslint-disable-next-line @next/next/no-img-element -- resized by our image route */}
      <img src={src} alt={alt} loading="lazy" className="block aspect-[3/2] w-full object-cover" />
      <span className="absolute left-1.5 top-1.5">
        <SyntheticBadge />
      </span>
    </div>
  );
}

function Placeholder({ text }: { text: string }) {
  return <div className="flex aspect-[3/2] w-full items-center justify-center rounded-lg border border-dashed border-zinc-300 text-xs font-medium text-zinc-500">{text}</div>;
}

export function DemoRunner({ scenarios }: { scenarios: ScenarioView[] }) {
  const [results, setResults] = useState<Record<string, StepResult>>({});
  const [loaded, setLoaded] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [resetState, setResetState] = useState<"idle" | "done" | { failed: string }>("idle");

  // Progress lives in the shared world, not in this page: what each step has done is read back when the
  // page opens, so a trip to the staff view (or another visitor's run) does not reset the scenarios.
  useEffect(() => {
    let active = true;
    (async () => {
      try {
        const res = await fetch("/api/demo/state", { cache: "no-store" });
        if (res.ok && active) setResults((await res.json()) as Record<string, StepResult>);
      } catch {
        // Unreachable server: the steps start unchecked, and running one says whether the world agrees.
      } finally {
        if (active) setLoaded(true);
      }
    })();
    return () => {
      active = false;
    };
  }, []);

  async function reset() {
    setBusy("reset");
    try {
      const res = await fetch("/api/demo/reset", { method: "POST" });
      const body = (await res.json().catch(() => ({}))) as { error?: string };
      if (!res.ok) throw new Error(body.error);
      setResults({});
      setResetState("done");
    } catch (err) {
      setResetState({ failed: err instanceof Error && err.message ? err.message : "The reset failed. Try again." });
    } finally {
      setBusy(null);
    }
  }

  async function run(scenario: string, step: number) {
    const key = `${scenario}:${step}`;
    setBusy(key);
    try {
      const res = await fetch("/api/demo/step", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ scenario, step }) });
      const body = (await res.json().catch(() => ({}))) as StepResult;
      setResults((r) => ({ ...r, [key]: res.ok ? body : { error: body.error ?? "Failed." } }));
    } catch {
      setResults((r) => ({ ...r, [key]: { error: "Could not reach the server." } }));
    } finally {
      setBusy(null);
    }
  }

  const ok = (r: StepResult | undefined) => Boolean(r && !r.error);

  return (
    <div className="mt-8 space-y-6">
      <div className="sticky top-[57px] z-10 -mx-4 flex flex-wrap items-center gap-3 border-b border-zinc-200 bg-white/95 px-4 py-3 backdrop-blur sm:static sm:mx-0 sm:rounded-xl sm:border sm:px-4">
        <button onClick={reset} disabled={busy !== null || !loaded} className="rounded-lg bg-zinc-900 px-4 py-2 text-sm font-semibold text-white hover:bg-zinc-800 disabled:opacity-50">
          {busy === "reset" ? "Resetting…" : "Reset the demo"}
        </button>
        <span className="text-sm text-zinc-500">
          {resetState === "done" ? (
            <span className="text-emerald-700">Back to the starting state.</span>
          ) : typeof resetState === "object" ? (
            <span className="text-rose-700">{resetState.failed}</span>
          ) : !loaded ? (
            "Reading what has run so far…"
          ) : Object.keys(results).length > 0 ? (
            "Steps already run, by you or another visitor, show their result. Reset to start over."
          ) : (
            "Start here, so every scenario begins the same way."
          )}
        </span>
        <Link href="/admin" className="ml-auto text-sm font-medium text-zinc-900 underline underline-offset-2">
          Staff console →
        </Link>
      </div>

      {scenarios.map((sc, n) => (
        <section key={sc.id} className="rounded-2xl border border-zinc-200 p-4 sm:p-5">
          <div className="flex items-baseline gap-3">
            <span className="font-mono text-xs text-zinc-400">{String(n + 1).padStart(2, "0")}</span>
            <h2 className="font-semibold">{sc.title}</h2>
          </div>
          <p className="mt-1.5 text-sm text-zinc-600">{sc.story}</p>

          {sc.world.map((w) => (
            <div key={w.title} className="mt-4 flex items-center gap-3 rounded-xl bg-zinc-50 p-3">
              <div className="w-24 shrink-0 sm:w-36">
                <Thumb src={w.photo} alt={`Open incident: ${w.title}`} />
              </div>
              <div className="text-sm">
                <div className="text-xs font-semibold uppercase tracking-wide text-zinc-500">Already open</div>
                <div className="mt-0.5 font-medium">{w.title}</div>
                <div className="text-zinc-600">Reported 3 days ago, before this scenario starts.</div>
              </div>
            </div>
          ))}

          <ol className="mt-4 space-y-3">
            {sc.steps.map((st, i) => {
              const key = `${sc.id}:${i}`;
              const r = results[key];
              const ran = ok(r);
              const locked = i > 0 && !ok(results[`${sc.id}:${i - 1}`]);
              const disabled = busy !== null || !loaded || locked || (st.kind === "repair" && ran);
              return (
                <li key={key} className="rounded-xl border border-zinc-200 p-3">
                  <div className="flex gap-3">
                    <span className={`mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-full text-[11px] font-semibold ${ran ? "bg-zinc-900 text-white" : "bg-zinc-100 text-zinc-500"}`}>
                      {ran ? "✓" : i + 1}
                    </span>
                    <div className={`${st.photo ? "w-24" : "hidden sm:block"} shrink-0 sm:w-36`}>
                      {st.photo ? (
                        <Thumb src={st.photo} alt={st.text} />
                      ) : st.message ? (
                        <Placeholder text={st.message.kind === "voice" ? "Voice, no photo" : "Text, no photo"} />
                      ) : (
                        <Placeholder text={st.kind === "repair" ? "Staff action" : st.kind === "brief" ? "Case brief agent" : "Verification agent"} />
                      )}
                    </div>
                    <div className="min-w-0 flex-1">
                      <div className="text-sm font-medium">{st.text}</div>
                      <p className="mt-0.5 text-sm text-zinc-600">{st.why}</p>
                      {st.message && <p className="mt-1.5 border-l-2 border-zinc-200 pl-2 text-sm italic text-zinc-700">“{st.message.text}”</p>}
                      {st.message?.audio && <audio controls preload="none" src={st.message.audio} className="mt-1.5 h-8 w-full max-w-xs" />}
                    </div>
                  </div>

                  <div className="mt-3 flex flex-wrap items-center gap-x-3 gap-y-2 sm:pl-9">
                    <button
                      onClick={() => run(sc.id, i)}
                      disabled={disabled}
                      title={locked ? "Run the previous step first." : undefined}
                      className="rounded-lg border border-zinc-300 px-3 py-1.5 text-sm font-medium hover:border-zinc-400 hover:bg-zinc-50 disabled:opacity-50"
                    >
                      {busy === key ? "Running…" : ran && st.kind === "repair" ? "Recorded" : ACTION[st.kind]}
                    </button>
                    {st.expect && (
                      <span className="flex items-center gap-1 text-xs text-zinc-500">
                        Expected {st.urgent && <UrgentBadge />} <LabelBadge label={st.expect} />
                      </span>
                    )}
                    {r?.label && (
                      <span className="flex items-center gap-1 text-xs text-zinc-500">
                        Suggested <LabelBadge label={r.label} />
                        {st.expect && (r.label === st.expect ? <span className="text-emerald-700">as expected</span> : <span className="text-amber-700">differs from expected</span>)}
                      </span>
                    )}
                    {r?.done && <span className="text-sm text-emerald-700">Done.</span>}
                    {r?.brief && (
                      <span className={`text-xs ${r.brief.status === "written" ? "text-emerald-700" : "text-amber-700"}`}>
                        {r.brief.status === "written"
                          ? `Brief written: ${r.brief.kept} items, every one citing evidence${r.brief.dropped ? ` (${r.brief.dropped} deleted without)` : ""}`
                          : "The brief was not finished; its reads are recorded on the staff view."}
                      </span>
                    )}
                    {r?.report_id && (
                      <span className="flex gap-3 text-sm sm:ml-auto">
                        <Link href={`/admin/reports/${r.report_id}`} className="font-medium text-zinc-900 underline underline-offset-2">
                          Staff view
                        </Link>
                        <Link href={`/track/${r.tracking_code}`} className="text-zinc-900 underline underline-offset-2">
                          Resident view
                        </Link>
                      </span>
                    )}
                    {r?.error && <span className="w-full text-sm text-rose-700">{r.error}</span>}
                  </div>
                </li>
              );
            })}
          </ol>
        </section>
      ))}
    </div>
  );
}
