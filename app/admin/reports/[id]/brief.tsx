// Author: HyeonMo Gu
// Created: 2026-11-01

"use client";

// A staff-requested case brief as it is written: the agent's reads arrive one by one from the brief route,
// then the page refreshes to show the stored brief. The brief never changes the suggestion; it is read beside it.
import { useRouter } from "next/navigation";
import { createContext, useContext, useState, useTransition, type ReactNode } from "react";
import type { BriefEvent, BriefResult } from "@/lib/server/briefs";
import type { BriefFact } from "@/lib/agent/brief";
import type { Brief } from "@/lib/tools/write-brief";
import { Panel } from "@/app/_ui/console";
import { plural, summarize, TOOL_TEXT, type StepView } from "./steps";
import { clockOf, Spinner, useElapsed } from "./verify";

type Phase = "idle" | "running" | "finished";
type State = { phase: Phase; steps: StepView[]; startedAt: number; note: { tone: "info" | "warn" | "error"; text: string } | null };

const Ctx = createContext<{ state: State; start: (analysisId: number) => void; busy: boolean } | null>(null);

export const useBrief = () => useContext(Ctx);

export function BriefProvider({ reportId, children }: { reportId: string; children: ReactNode }) {
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
      const res = await fetch(`/api/admin/reports/${reportId}/brief`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ analysis_id: analysisId }),
      });
      if (!res.ok || !res.body) {
        const body = (await res.json().catch(() => ({}))) as { error?: string };
        return finish({ tone: "error", text: body.error ?? "Could not write the brief." });
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
          const event = JSON.parse(line) as BriefEvent;
          if (event.type === "step") setState((s) => ({ ...s, steps: [...s.steps, event.step] }));
          else if (event.type === "result") return finish(noteOf(event.result));
          else return finish({ tone: "error", text: event.error });
        }
      }
      finish({ tone: "error", text: "The connection closed before the brief was finished. Reload to see whether it was saved." });
    } catch {
      finish({ tone: "error", text: "The connection was lost. Reload to see whether the brief was saved." });
    }
  }

  return <Ctx.Provider value={{ state, start, busy: state.phase === "running" || refreshing }}>{children}</Ctx.Provider>;
}

// A finished run is shown by the brief card once the page refreshes; a run that did not start is said here.
function noteOf(r: BriefResult): State["note"] {
  if (r.status === "finished") return null;
  if (r.reason === "no_recording") return { tone: "info", text: "The agent did not start: the public demo has no recorded brief for this report." };
  if (r.reason === "budget") return { tone: "info", text: "The agent did not start: live model calls are paused for today." };
  return { tone: "error", text: "The agent could not start." };
}

/** The run as it happens, under the decision band. */
export function BriefProgress({ maxSteps, maxMs }: { maxSteps: number; maxMs: number }) {
  const b = useBrief();
  const running = b?.state.phase === "running";
  const elapsed = useElapsed(running ? b!.state.startedAt : 0, running);
  if (!b) return null;
  const { state } = b;

  if (state.phase === "finished") {
    if (!state.note) {
      return b.busy ? (
        <section className="mt-2 flex items-center gap-3 rounded-lg border border-violet-500/40 bg-ops-panel px-4 py-3 text-sm text-violet-100" role="status">
          <Spinner className="text-violet-300" />
          Brief written. Loading it…
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
  if (!running) return null;

  const last = state.steps.at(-1);
  const now = last?.tool === "write_brief" ? "Checking every item's evidence, then saving" : state.steps.length === 0 ? "Reading the report, the pipeline's facts and the history" : "Deciding what else to read";
  const reads = state.steps.filter((s) => s.tool !== "write_brief").length;
  return (
    <section className="mt-2 rounded-lg border border-violet-500/40 bg-ops-panel px-4 py-3" role="status" aria-live="polite">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
        <Spinner className="text-violet-300" />
        <p className="font-semibold text-white">The brief agent is reading the evidence for this report</p>
        <span className="ml-auto font-mono text-[11px] text-ops-dim">
          {plural(reads, "read")} of up to {maxSteps} · {clockOf(elapsed)} of up to {clockOf(maxMs)}
        </span>
      </div>
      <div className="mt-2 h-1 overflow-hidden rounded-full bg-ops-raised">
        <div className="h-full rounded-full bg-violet-400 transition-[width] duration-500" style={{ width: `${Math.min(100, Math.max((reads / maxSteps) * 100, (elapsed / maxMs) * 100, 4))}%` }} />
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
        <li className="flex items-center gap-2.5 text-violet-200">
          <span className="flex w-4 shrink-0 justify-center">
            <Spinner className="h-3 w-3" />
          </span>
          {now}
        </li>
      </ol>
      <p className="mt-3 border-t border-ops-line pt-2 text-[11px] text-ops-dim">The brief does not change the suggestion. Items without a cited tool result or fact are deleted before it is shown.</p>
    </section>
  );
}

export type StoredBrief = {
  id: number;
  analysis_id: number;
  requested_by: string;
  status: string;
  steps: unknown;
  facts: unknown;
  brief: unknown;
  dropped: number;
  error: string | null;
  cost_usd: number;
  latency_ms: number;
  created_at: string;
};

const SECTION_TEXT: Record<string, string> = {
  reported: "What was reported",
  photos: "What the photos show",
  nearby: "Nearby",
  history: "History",
  missing: "Still unknown",
  next: "What staff could do next",
};

// The refs behind an item; the tooltip holds the fact or tool result they name.
function Refs({ refs, explain }: { refs: string[]; explain: (ref: string) => string }) {
  return (
    <span className="ml-1.5 inline-flex flex-wrap gap-1 align-middle">
      {refs.map((ref) => (
        <span key={ref} title={explain(ref)} className="cursor-help rounded border border-violet-500/40 bg-violet-500/10 px-1 font-mono text-[10px] leading-4 text-violet-200">
          {ref.replace("_", " ")}
        </span>
      ))}
    </span>
  );
}

/** The latest stored brief: the summary, its sections, and every item's evidence in a tooltip. */
export function BriefCard({ stored, stale }: { stored: StoredBrief; stale: boolean }) {
  const brief = stored.brief as Brief | null;
  const steps = stored.steps as StepView[];
  const facts = stored.facts as BriefFact[];
  const explain = (ref: string): string => {
    const fact = facts.find((f) => f.ref === ref);
    if (fact) return fact.text;
    const step = steps.find((s) => s.ref === ref);
    return step ? `${TOOL_TEXT[step.tool] ?? step.tool}: ${summarize(step)}` : ref;
  };
  const sections = Object.keys(SECTION_TEXT).map((key) => ({ key, items: (brief?.items ?? []).filter((i) => i.section === key) })).filter((s) => s.items.length > 0);
  const reads = steps.filter((s) => s.ok && s.tool !== "write_brief").length;
  return (
    <Panel
      title="Case brief"
      aside={
        <span className="font-mono">
          Muse Spark · {plural(reads, "read")} · ${stored.cost_usd.toFixed(3)} · {(stored.latency_ms / 1000).toFixed(1)}s
        </span>
      }
      className="border-violet-500/40"
    >
      {brief ? (
        <div className="space-y-4">
          {brief.summary && (
            <p className="text-[15px] leading-relaxed text-white">
              {brief.summary.text}
              <Refs refs={brief.summary.evidence_refs} explain={explain} />
            </p>
          )}
          {sections.map((s) => (
            <div key={s.key}>
              <h3 className="text-[11px] font-semibold uppercase tracking-[0.12em] text-violet-300">{SECTION_TEXT[s.key]}</h3>
              <ul className="mt-1 space-y-1 text-[13px] text-ops-text">
                {s.items.map((item, i) => (
                  <li key={i} className="leading-relaxed">
                    {item.text}
                    <Refs refs={item.evidence_refs} explain={explain} />
                  </li>
                ))}
              </ul>
            </div>
          ))}
          {brief.items.length === 0 && <p className="text-sm text-amber-200">Every item the agent wrote lacked evidence, so nothing is shown.</p>}
        </div>
      ) : (
        <p className="text-sm text-amber-200">The brief was not finished ({stored.status.replace("_", " ")}{stored.error ? `: ${stored.error}` : ""}). Its reads are recorded below.</p>
      )}
      <p className="mt-4 flex flex-wrap items-center gap-x-3 gap-y-1 border-t border-ops-line pt-2 text-[11px] text-ops-dim">
        <span>Every item cites a tool result or a pipeline fact; hover a ref to read it.</span>
        {stored.dropped > 0 && <span className="text-amber-300">{plural(stored.dropped, "item")} deleted for lacking evidence.</span>}
        {stale && <span className="text-amber-300">Written on an earlier analysis of this report.</span>}
        <span className="ml-auto">It does not decide anything.</span>
      </p>
      {steps.length > 0 && (
        <ol className="mt-3 space-y-1 text-[12px]">
          {steps.map((s) => (
            <li key={s.ref} className="flex gap-2.5">
              <span className="w-12 shrink-0 font-mono text-[10px] text-ops-dim">{s.ref.replace("_", " ")}</span>
              <span className="min-w-0">
                <span className="font-medium text-white">{TOOL_TEXT[s.tool] ?? s.tool}</span>
                <span className={`ml-2 break-words ${s.ok ? "text-ops-text" : "text-rose-300"}`}>{summarize(s)}</span>
              </span>
            </li>
          ))}
        </ol>
      )}
    </Panel>
  );
}
