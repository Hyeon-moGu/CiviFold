// Author: HyeonMo Gu
// Created: 2026-10-28

"use client";

// A staff-requested verification as it happens: the agent's checks arrive one by one from the verify route,
// and the outcome is said in words. The stored result (the verdict card) takes over after a refresh.
import { useRouter } from "next/navigation";
import { createContext, useContext, useEffect, useState, useTransition, type ReactNode } from "react";
import type { VerifyEvent, VerifyResult } from "@/lib/server/reports";
import { plural, summarize, TOOL_TEXT, type StepView } from "./steps";

type Phase = "idle" | "running" | "finished";
type State = { phase: Phase; steps: StepView[]; startedAt: number; note: { tone: "info" | "warn" | "error"; text: string } | null };

const Ctx = createContext<{ state: State; start: (analysisId: number) => void; busy: boolean; refreshing: boolean } | null>(null);

export const useVerify = () => useContext(Ctx);

export function VerifyProvider({ reportId, children }: { reportId: string; children: ReactNode }) {
  const router = useRouter();
  const [state, setState] = useState<State>({ phase: "idle", steps: [], startedAt: 0, note: null });
  const [refreshing, startRefresh] = useTransition();

  async function start(analysisId: number) {
    setState({ phase: "running", steps: [], startedAt: Date.now(), note: null });
    const finish = (note: State["note"]) => {
      setState((s) => ({ ...s, phase: "finished", note }));
      startRefresh(() => router.refresh());
    };
    try {
      const res = await fetch(`/api/admin/reports/${reportId}/verify`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ analysis_id: analysisId }),
      });
      if (!res.ok || !res.body) {
        const body = (await res.json().catch(() => ({}))) as { error?: string };
        return finish({ tone: "error", text: body.error ?? "Could not run the verification." });
      }
      const reader = res.body.pipeThrough(new TextDecoderStream()).getReader();
      let buffer = "";
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += value;
        const lines = buffer.split("\n");
        buffer = lines.pop() ?? "";
        for (const line of lines.filter(Boolean)) {
          const event = JSON.parse(line) as VerifyEvent;
          if (event.type === "step") setState((s) => ({ ...s, steps: [...s.steps, event.step] }));
          else if (event.type === "result") return finish(noteOf(event.result));
          else return finish({ tone: "error", text: event.error });
        }
      }
      finish({ tone: "error", text: "The connection closed before the verification finished. Reload to see whether it was saved." });
    } catch {
      finish({ tone: "error", text: "The connection was lost. Reload to see whether the verification was saved." });
    }
  }

  return <Ctx.Provider value={{ state, start, busy: state.phase === "running" || refreshing, refreshing }}>{children}</Ctx.Provider>;
}

// Applied results are shown by the verdict card once the page refreshes; the rest are said here.
function noteOf(r: VerifyResult): State["note"] {
  switch (r.status) {
    case "applied":
      return null;
    case "facts_changed":
      return { tone: "warn", text: "Not run: an incident this suggestion relied on changed since. Analyze the report again first." };
    case "superseded":
      return { tone: "warn", text: "The report changed while the agent ran (a staff decision or a newer analysis), so its result was recorded but not applied." };
    case "not_started":
      if (r.reason === "no_recording") return { tone: "info", text: "The agent did not start: the public demo has no recorded run for this report. The suggestion is unchanged." };
      if (r.reason === "budget") return { tone: "info", text: "The agent did not start: live model calls are paused for today. The suggestion is unchanged." };
      return { tone: "error", text: "The agent could not start. The suggestion is unchanged." };
  }
}

export function useElapsed(since: number, on: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!on) return;
    const t = setInterval(() => setNow(Date.now()), 500);
    return () => clearInterval(t);
  }, [on]);
  return Math.max(0, now - since);
}

export const clockOf = (ms: number) => `${Math.floor(ms / 60_000)}:${String(Math.floor(ms / 1000) % 60).padStart(2, "0")}`;

export function Spinner({ className = "" }: { className?: string }) {
  return <span aria-hidden className={`inline-block h-3.5 w-3.5 shrink-0 animate-spin rounded-full border-2 border-current border-r-transparent ${className}`} />;
}

/**
 * The run as it happens, under the decision band. runningSince: a verification another tab or person
 * started; the page refreshes until it is done.
 */
export function VerifyProgress({ maxSteps, maxMs, runningSince }: { maxSteps: number; maxMs: number; runningSince: string | null }) {
  const v = useVerify();
  const router = useRouter();
  const elsewhere = v?.state.phase === "idle" && runningSince !== null;
  const running = v?.state.phase === "running";
  const elapsed = useElapsed(running ? v!.state.startedAt : runningSince ? Date.parse(runningSince) : 0, running || elsewhere);

  useEffect(() => {
    if (!elsewhere) return;
    const t = setInterval(() => router.refresh(), 4000);
    return () => clearInterval(t);
  }, [elsewhere, router]);

  if (!v) return null;
  const { state } = v;

  if (elsewhere) {
    return (
      <section className="mt-2 flex items-center gap-3 rounded-lg border border-sky-500/40 bg-sky-500/10 px-4 py-3 text-sm text-sky-100" role="status">
        <Spinner className="text-sky-300" />
        <span>A verification started {clockOf(elapsed)} ago is still running. This page updates when it finishes.</span>
      </section>
    );
  }

  if (state.phase === "finished") {
    if (!state.note) {
      return v.refreshing ? (
        <section className="mt-2 flex items-center gap-3 rounded-lg border border-sky-500/40 bg-ops-panel px-4 py-3 text-sm text-sky-100" role="status">
          <Spinner className="text-sky-300" />
          Verification finished. Loading the result…
        </section>
      ) : null;
    }
    const tone = { info: "border-ops-line bg-ops-panel text-ops-text", warn: "border-amber-500/40 bg-amber-500/10 text-amber-100", error: "border-rose-500/40 bg-rose-500/10 text-rose-100" }[state.note.tone];
    return (
      <section className={`mt-2 rounded-lg border px-4 py-3 text-sm ${tone}`} role="status">
        {state.note.text}
      </section>
    );
  }
  if (state.phase !== "running") return null;

  const last = state.steps.at(-1);
  const now =
    last?.tool === "propose_decision"
      ? "Rerunning the decision rules on everything it found, then saving"
      : state.steps.length === 0
        ? "Reading the report and the suggestion, choosing the first check"
        : "Choosing the next check";
  const checks = state.steps.filter((s) => s.tool !== "propose_decision").length;
  return (
    <section className="mt-2 rounded-lg border border-sky-500/40 bg-ops-panel px-4 py-3" role="status" aria-live="polite">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
        <Spinner className="text-sky-300" />
        <p className="font-semibold text-white">The verification agent is looking for evidence against this suggestion</p>
        <span className="ml-auto font-mono text-[11px] text-ops-dim">
          {plural(checks, "check")} of up to {maxSteps} · {clockOf(elapsed)} of up to {clockOf(maxMs)}
        </span>
      </div>
      <div className="mt-2 h-1 overflow-hidden rounded-full bg-ops-raised">
        <div className="h-full rounded-full bg-sky-400 transition-[width] duration-500" style={{ width: `${Math.min(100, Math.max((checks / maxSteps) * 100, (elapsed / maxMs) * 100, 4))}%` }} />
      </div>
      <ol className="mt-3 space-y-1.5 text-[12px]">
        {state.steps.map((s) => (
          <li key={s.ref} className="flex gap-2.5">
            <span className={`mt-px w-4 shrink-0 text-center ${s.ok ? "text-emerald-300" : "text-rose-300"}`}>{s.ok ? "✓" : "✕"}</span>
            <span className="min-w-0">
              <span className="font-medium text-white">{TOOL_TEXT[s.tool] ?? s.tool}</span>
              <span className={`ml-2 break-words ${s.ok ? "text-ops-text" : "text-rose-300"}`}>{summarize(s)}</span>
            </span>
          </li>
        ))}
        <li className="flex items-center gap-2.5 text-sky-200">
          <span className="flex w-4 shrink-0 justify-center">
            <Spinner className="h-3 w-3" />
          </span>
          {now}
        </li>
      </ol>
      <p className="mt-3 border-t border-ops-line pt-2 text-[11px] text-ops-dim">
        Nothing changes until it finishes. The agent can only make the suggestion more cautious; if it cannot start, the suggestion stays as it is.
      </p>
    </section>
  );
}

/** Runs the fast path again on a suggestion an incident change made out of date. */
export function ReanalyzeButton({ reportId, analysisId }: { reportId: string; analysisId: number }) {
  const router = useRouter();
  const v = useVerify();
  const [startedAt, setStartedAt] = useState<number | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [refreshing, startRefresh] = useTransition();
  const elapsed = useElapsed(startedAt ?? 0, startedAt !== null);

  async function run() {
    setStartedAt(Date.now());
    setMessage(null);
    try {
      const res = await fetch(`/api/admin/reports/${reportId}/reanalyze`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ analysis_id: analysisId }),
      });
      const body = (await res.json().catch(() => ({}))) as { status?: string; message?: string; error?: string };
      if (!res.ok) return setMessage(body.error ?? "Could not analyze it again.");
      if (body.status === "not_started") return setMessage(body.message ?? "The analysis could not run. The current suggestion is unchanged.");
      if (body.status === "superseded") setMessage("Another analysis or a staff decision came first.");
      startRefresh(() => router.refresh());
    } catch {
      // It may still be running or saved on the server: show what is stored now.
      setMessage("Could not confirm the result (connection problem). The page was reloaded to show what is stored.");
      startRefresh(() => router.refresh());
    } finally {
      setStartedAt(null);
    }
  }

  const running = startedAt !== null || refreshing;
  return (
    <div className="flex flex-col gap-1.5 sm:items-end">
      <button
        onClick={run}
        disabled={running || Boolean(v?.busy)}
        className="inline-flex items-center gap-2 rounded-md bg-white px-4 py-2 text-sm font-semibold text-slate-950 transition hover:bg-zinc-200 disabled:opacity-60"
      >
        {running && <Spinner />}
        {startedAt !== null ? `Analyzing again… ${clockOf(elapsed)}` : refreshing ? "Loading the new suggestion…" : "Analyze again"}
      </button>
      {message && <p className="text-[12px] text-amber-100">{message}</p>}
    </div>
  );
}
