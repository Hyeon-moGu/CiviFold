// Author: HyeonMo Gu
// Created: 2026-11-01

"use client";

// A staff-requested case brief as it is written: the agent's reads arrive one by one from the brief route,
// then the page refreshes to show the stored brief. The brief never changes the suggestion; it is read beside it.
import { useRouter } from "next/navigation";
import { createContext, useContext, useEffect, useRef, useState, useTransition, type ReactNode } from "react";
import type { BriefEvent, BriefResult } from "@/lib/server/briefs";
import type { BriefFact } from "@/lib/agent/brief";
import type { Brief } from "@/lib/tools/write-brief";
import { cost, when } from "@/app/_ui/format";
import { plural, summarize, TOOL_TEXT, type StepView } from "./steps";
import { clockOf, intoView, liveText, pacer, Spinner, useElapsed, withNames, type LiveRun } from "./verify";
import { pauseFrom } from "@/app/_ui/pause";

type Phase = "idle" | "running" | "finished";
type State = { phase: Phase; steps: StepView[]; startedAt: number; note: { tone: "info" | "warn" | "error"; text: string } | null };

const Ctx = createContext<{ state: State; start: (analysisId: number) => void; busy: boolean; paced: boolean } | null>(null);

export const useBrief = () => useContext(Ctx);

// paceMs: set when runs are replayed from recordings (pacer).
export function BriefProvider({ reportId, paceMs = 0, children }: { reportId: string; paceMs?: number; children: ReactNode }) {
  const router = useRouter();
  const [state, setState] = useState<State>({ phase: "idle", steps: [], startedAt: 0, note: null });
  const [refreshing, startRefresh] = useTransition();

  async function start(analysisId: number) {
    setState({ phase: "running", steps: [], startedAt: Date.now(), note: null });
    const finish = (note: State["note"]) => {
      setState((s) => ({ ...s, phase: "finished", note }));
      startRefresh(() => router.refresh());
    };
    const pace = pacer(paceMs);
    try {
      const res = await fetch(`/api/admin/reports/${reportId}/brief`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ analysis_id: analysisId }),
      });
      pauseFrom(res, "live");
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
          await pace();
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

  return <Ctx.Provider value={{ state, start, busy: state.phase === "running" || refreshing, paced: paceMs > 0 }}>{children}</Ctx.Provider>;
}

// A finished run is shown by the brief card once the page refreshes; a run that did not start is said here.
function noteOf(r: BriefResult): State["note"] {
  if (r.status === "finished") return null;
  if (r.reason === "no_recording") return { tone: "info", text: "The agent did not start: the public demo has no recorded brief for this report." };
  if (r.reason === "budget") return { tone: "info", text: "The agent did not start: live model calls are paused for today." };
  return { tone: "error", text: "The agent could not start." };
}

/** The run as it happens, under the decision band. */
export function BriefProgress({ maxSteps, maxMs, live = null, names = {} }: { maxSteps: number; maxMs: number; live?: LiveRun; names?: Record<string, string> }) {
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
    <section ref={intoView} className="mt-2 scroll-mt-60 rounded-lg border border-violet-500/40 bg-ops-panel px-4 py-3" role="status" aria-live="polite">
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
              <span className={`ml-2 break-words ${s.ok ? "text-ops-text" : "text-rose-300"}`}>{withNames(summarize(s), names)}</span>
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
      <p className="mt-3 border-t border-ops-line pt-2 text-[11px] text-ops-dim">
        {b.paced && "Replaying a recorded run, one read at a time. "}
        {live && liveText(live)}
        The brief does not change the suggestion. Items without a cited tool result or fact are deleted before it is shown.
      </p>
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

// Fact texts and step results carry image ids; staff read names instead. A dataset id names the photo's state,
// so an id without a name is still hidden. Their UTC timestamps are shown in the zone the rest of the page uses.
const LEFTOVER_ID = /\b(?:syn_[A-Za-z0-9_]+|img_[0-9a-f]+)\b/g;
const ISO_TIME = /\b\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z\b/g;

function nameIds(text: string, names: Record<string, string>): string {
  let out = text;
  for (const id of Object.keys(names).sort((a, b) => b.length - a.length)) out = out.split(id).join(names[id]);
  out = out.replace(LEFTOVER_ID, "a photo").replace(ISO_TIME, (t) => when(t));
  // The agent may name a thing twice ("Report report_01 shows", "Incident incident_01 opened"): keep the name alone.
  out = out.replace(/\b[Rr]eport (this report)\b/g, "$1").replace(/\b[Ii]ncident (the )/g, "$1");
  // A name put in place of an id can open a sentence ("this report shows ..."); an id itself keeps its case.
  return out.replace(/(^|[.!?]\s+)(this|the) /g, (_, before: string, word: string) => `${before}${word.charAt(0).toUpperCase()}${word.slice(1)} `);
}

type OpenChip = { open: string | null; toggle: (key: string) => void };

// The refs behind an item, as small numbers. Each opens a popover with the fact or tool result it names;
// one is open at a time. Numbers follow first appearance in the brief, so the same evidence keeps its number.
// The note opens to the left of its number; near the left edge of a narrow screen it is moved back into view.
const keepOnScreen = (el: HTMLElement | null) => {
  if (!el) return;
  const { left, right } = el.getBoundingClientRect();
  const shift = left < 8 ? 8 - left : right > window.innerWidth - 8 ? window.innerWidth - 8 - right : 0;
  if (shift) el.style.transform = `translateX(${shift}px)`;
};

function Refs({ id, refs, number, explain, chip }: { id: string; refs: string[]; number: (ref: string) => number; explain: (ref: string) => string; chip: OpenChip }) {
  return (
    <sup className="ml-0.5 inline-flex gap-0.5 align-super">
      {refs.map((ref) => {
        const key = `${id}-${ref}`;
        const open = chip.open === key;
        return (
          <span key={ref} data-brief-ref className="relative inline-block">
            <button
              type="button"
              onClick={() => chip.toggle(key)}
              aria-expanded={open}
              aria-controls={open ? `brief-ref-${key}` : undefined}
              aria-label={`Evidence ${number(ref)}: ${ref.replace("_", " ")}`}
              className={`min-w-[1.1rem] rounded px-1 font-mono text-[10px] leading-4 transition ${open ? "bg-violet-400 text-slate-950" : "bg-violet-500/20 text-violet-200 hover:bg-violet-500/35"}`}
            >
              {number(ref)}
            </button>
            {open && (
              <span
                ref={keepOnScreen}
                id={`brief-ref-${key}`}
                role="note"
                className="absolute right-0 top-full z-20 mt-1 block w-72 max-w-[80vw] rounded-md border border-ops-line bg-ops-raised px-3 py-2 text-left text-[12px] font-normal leading-relaxed text-ops-text shadow-lg shadow-black/40"
              >
                <span className="mb-0.5 block font-mono text-[10px] text-violet-300">
                  Evidence {number(ref)}
                </span>
                {explain(ref)}
              </span>
            )}
          </span>
        );
      })}
    </sup>
  );
}

// What the brief adds to the screen. The other sections retell the photos, the nearby incidents and the
// history that the page already shows, so they wait behind "Show all".
const UP_FRONT = new Set(["missing", "next"]);

/** The latest stored brief beside the evidence: the summary and what is still open, the rest one click away. */
// Facts are written for the model (and replayed word for word), so they keep its terse form; staff read them with
// the categories and yes-or-no fields in words.
function readableFact(text: string): string {
  return text
    .replace(/\b(?:fire_hydrant|traffic_sign|road_damage)\b/g, (c) => c.replace("_", " "))
    .replace(/;\s*out of scope: false/g, "")
    .replace(/\((full|crops)\):/g, (_, m: string) => (m === "crops" ? "(cut-outs):" : "(whole photos):"))
    .replace(/asset (same|different|uncertain) \((\d(?:\.\d+)?)\)/g, (_, v: string, x: string) =>
      `${v === "same" ? "same fixture" : v === "different" ? "a different fixture" : "unsure if the same fixture"} (model confidence ${Math.round(Number(x) * 100)}%)`,
    )
    .replace(/problem visible true/g, "problem visible")
    .replace(/problem visible false/g, "no problem visible")
    .replace(/signature same/g, "same problem")
    .replace(/signature different/g, "a different problem")
    .replace(/signature uncertain/g, "unsure if the same problem")
    .replace(/, missing none/g, "")
    .replace(/missing ([a-z_,]+)/g, (_, m: string) => `asks for ${m.replace(/_/g, " ").replace(/,/g, ", ")}`)
    .replace(/ by rule R\w+/g, "")
    .replace(/\bcandidate\b/gi, "the incident's photo")
    .replace(/\bNEW\b/g, "this photo")
    .replace(/(^|; )new (?=shows|has|is)/g, "$1this photo ")
    .replace(/repair signs: false/g, "no repair signs")
    .replace(/repair signs: true/g, "repair signs seen")
    .replace(/resident already asked: no/g, "the resident has not been asked yet")
    .replace(/resident already asked: yes/g, "the resident was already asked");
}

export function BriefCard({ stored, stale, names }: { stored: StoredBrief; stale: boolean; names: Record<string, string> }) {
  const brief = stored.brief as Brief | null;
  const steps = stored.steps as StepView[];
  const facts = stored.facts as BriefFact[];
  const [open, setOpen] = useState<string | null>(null);
  const [all, setAll] = useState(false);
  // A brief just written lands in the side column, often below the fold: bring it into view.
  const card = useRef<HTMLElement>(null);
  const b = useBrief();
  const fresh = b?.state.phase === "finished" && !b.state.note && !b.busy;
  useEffect(() => {
    if (fresh) card.current?.scrollIntoView({ block: "center", behavior: "smooth" });
  }, [fresh]);
  useEffect(() => {
    if (open === null) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(null);
    };
    // A click anywhere but on a number or its note closes the note.
    const onDown = (e: PointerEvent) => {
      if (!(e.target instanceof Element && e.target.closest("[data-brief-ref]"))) setOpen(null);
    };
    window.addEventListener("keydown", onKey);
    window.addEventListener("pointerdown", onDown);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("pointerdown", onDown);
    };
  }, [open]);
  const chip: OpenChip = { open, toggle: (key) => setOpen((o) => (o === key ? null : key)) };
  const clean = (text: string) => nameIds(text, names);
  const explain = (ref: string): string => {
    const fact = facts.find((f) => f.ref === ref);
    if (fact) return readableFact(clean(fact.text));
    const step = steps.find((s) => s.ref === ref);
    return step ? `${TOOL_TEXT[step.tool] ?? step.tool}: ${clean(summarize(step))}` : ref;
  };
  const sections = Object.keys(SECTION_TEXT).map((key) => ({ key, items: (brief?.items ?? []).filter((i) => i.section === key) })).filter((s) => s.items.length > 0);
  const order = [...(brief?.summary?.evidence_refs ?? []), ...sections.flatMap((s) => s.items.flatMap((i) => i.evidence_refs))];
  const numbers = new Map([...new Set(order)].map((ref, i) => [ref, i + 1]));
  const number = (ref: string) => numbers.get(ref) ?? 0;
  const shown = sections.filter((s) => all || UP_FRONT.has(s.key));
  const hidden = sections.filter((s) => !UP_FRONT.has(s.key)).reduce((n, s) => n + s.items.length, 0);
  const reads = steps.filter((s) => s.ok && s.tool !== "write_brief").length;
  const called = steps.some((s) => s.tool !== "write_brief");
  return (
    <section ref={card} id="brief" className={`scroll-mt-72 rounded-lg border border-violet-500/40 bg-ops-panel ${fresh ? "ring-2 ring-violet-400/50" : ""}`}>
      <header className="flex items-center gap-3 border-b border-ops-line px-4 py-2.5">
        <h2 className="text-[13px] font-medium text-ops-text">Case brief</h2>
        <span className="ml-auto text-xs text-ops-dim">Muse Spark · {called ? plural(reads, "read") : "from the stored facts"}</span>
      </header>
      <div className="space-y-4 p-4">
        {brief ? (
          <>
            {brief.summary && (
              <p className="text-[14px] leading-relaxed text-white">
                {clean(brief.summary.text)}
                <Refs id="summary" refs={brief.summary.evidence_refs} number={number} explain={explain} chip={chip} />
              </p>
            )}
            {shown.map((s) => (
              <div key={s.key}>
                <h3 className="text-[13px] font-medium text-violet-200">{SECTION_TEXT[s.key]}</h3>
                <ul className="mt-1 space-y-1.5 text-[13px] leading-relaxed text-ops-text">
                  {s.items.map((item, i) => (
                    <li key={i}>
                      {clean(item.text)}
                      <Refs id={`${s.key}-${i}`} refs={item.evidence_refs} number={number} explain={explain} chip={chip} />
                    </li>
                  ))}
                </ul>
              </div>
            ))}
            {hidden > 0 && (
              <button type="button" onClick={() => setAll((a) => !a)} className="text-[13px] font-medium text-white underline decoration-ops-dim underline-offset-2 hover:decoration-white">
                {all ? "Show less" : `Show all ${plural(brief.items.length, "item")}`}
              </button>
            )}
            {brief.items.length === 0 && <p className="text-sm text-amber-200">Every item the agent wrote lacked evidence, so nothing is shown.</p>}
          </>
        ) : (
          <p className="text-sm text-amber-200">The brief was not finished ({stored.status.replace("_", " ")}{stored.error ? `: ${clean(stored.error)}` : ""}). Its reads are recorded below.</p>
        )}
        <div className="space-y-1 border-t border-ops-line pt-2 text-[11px] text-ops-dim">
          <p>Every item cites a tool result or a pipeline fact; tap a number to read it. The brief decides nothing.</p>
          {stored.dropped > 0 && <p className="text-amber-300">{plural(stored.dropped, "item")} deleted for lacking evidence.</p>}
          {stale && <p className="text-amber-300">Written on an earlier analysis of this report.</p>}
        </div>
        {steps.length > 0 && (
          <details className="group text-[12px]">
            <summary className="cursor-pointer select-none text-ops-dim hover:text-white">
              What the agent read ({plural(steps.length, "step")}, {cost(stored.cost_usd)}, {(stored.latency_ms / 1000).toFixed(1)}s)
            </summary>
            <ol className="mt-2 space-y-1">
              {steps.map((st) => (
                <li key={st.ref} className="flex gap-2.5">
                  <span className="w-12 shrink-0 font-mono text-[10px] text-ops-dim">{st.ref.replace("_", " ")}</span>
                  <span className="min-w-0">
                    <span className="font-medium text-white">{TOOL_TEXT[st.tool] ?? st.tool}</span>
                    <span className={`ml-2 break-words ${st.ok ? "text-ops-text" : "text-rose-300"}`}>{clean(summarize(st))}</span>
                  </span>
                </li>
              ))}
            </ol>
          </details>
        )}
      </div>
    </section>
  );
}
