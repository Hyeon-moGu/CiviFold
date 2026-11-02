// Author: HyeonMo Gu
// Created: 2026-10-27

"use client";

import Link from "next/link";
import { useCallback, useEffect, useState, type ReactNode } from "react";
import type { Label } from "@/lib/tools/types";
import { LabelBadge, SyntheticBadge, UrgentBadge } from "@/app/_ui/labels";

type StepView = {
  kind: "repair" | "report" | "message" | "answer" | "verify" | "brief" | "decide";
  text: string;
  why: string;
  expect: Label | null;
  urgent: boolean;
  photo?: string;
  message?: { kind: "voice" | "text"; text: string; audio: string | null };
};
export type ScenarioView = { id: string; title: string; story: string; world: Array<{ title: string; photo: string }>; steps: StepView[] };
type StepResult = {
  report_id?: string;
  tracking_code?: string;
  label?: Label;
  incident_id?: string | null;
  location_only?: { label: Label; incident_id: string | null };
  brief?: { status: string; kept: number; dropped: number };
  decided?: { action: string; incident_id: string | null };
  done?: string;
};

// Suggestions that close a report onto an incident in one click.
const CLOSES: ReadonlySet<Label> = new Set(["DUPLICATE", "LATE_REPORT", "ALREADY_RESOLVED"]);

// A report that needs a person (a new problem, a recurrence, an emergency) is buried when it is closed as a repeat.
const needsAttention = (st: StepView) => st.expect === "NEW" || st.expect === "POSSIBLE_RECURRENCE" || st.urgent;

const sends = (st: StepView) => st.kind === "report" || st.kind === "message" || st.kind === "answer";

// The report a brief or a staff decision acts on: the latest step before it that sent one.
function ownerIndex(steps: StepView[], index: number): number {
  for (let i = index - 1; i >= 0; i--) if (steps[i]!.kind === "report" || steps[i]!.kind === "message") return i;
  return -1;
}

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

export function DemoRunner({ scenarios }: { scenarios: ScenarioView[] }) {
  const [results, setResults] = useState<Record<string, StepResult>>({});
  const [loaded, setLoaded] = useState(false);
  const [running, setRunning] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);

  // The world is shared and kept played: what each step did is read back from it, never kept in this page.
  const read = useCallback(async () => {
    const res = await fetch("/api/demo/state", { cache: "no-store" });
    if (res.ok) setResults((await res.json()) as Record<string, StepResult>);
  }, []);

  useEffect(() => {
    let active = true;
    (async () => {
      try {
        const res = await fetch("/api/demo/state", { cache: "no-store" });
        if (res.ok && active) setResults((await res.json()) as Record<string, StepResult>);
      } catch {
        // Unreachable server: the cases show as not run, and running them says whether the server answers.
      } finally {
        if (active) setLoaded(true);
      }
    })();
    return () => {
      active = false;
    };
  }, []);

  // The reset plays every scenario on the server; reading the world meanwhile shows the cases fill in.
  async function runAll() {
    setRunning(true);
    setFailure(null);
    setResults({});
    const poll = setInterval(() => read().catch(() => {}), 700);
    try {
      const res = await fetch("/api/demo/reset", { method: "POST" });
      const body = (await res.json().catch(() => ({}))) as { error?: string };
      if (!res.ok) setFailure(body.error ?? "The run failed. Try again.");
    } catch {
      setFailure("Could not reach the server.");
    } finally {
      clearInterval(poll);
      await read().catch(() => {});
      setRunning(false);
    }
  }

  const auto = scenarios.flatMap((sc) => sc.steps.map((st, i) => ({ sc, st, key: `${sc.id}:${i}` }))).filter(({ st }) => st.kind !== "decide");
  const done = auto.filter(({ key }) => results[key]).length;
  const judged = auto.filter(({ st, key }) => st.expect && results[key]?.label);
  const expected = judged.filter(({ st, key }) => results[key]!.label === st.expect).length;
  const attention = auto.filter(({ st, key }) => sends(st) && needsAttention(st) && results[key]?.label);
  const buriedByLocation = attention.filter(({ key }) => results[key]!.location_only?.label === "DUPLICATE").length;
  const buriedByUs = attention.filter(({ key }) => CLOSES.has(results[key]!.label!)).length;
  const empty = loaded && done === 0 && !running;

  return (
    <div className="mt-6 space-y-6">
      <section className="rounded-2xl border border-zinc-200 bg-zinc-50 p-5">
        {empty ? (
          <p className="text-[15px] text-zinc-700">The cases have not run in this world yet. Run them once; it takes a few seconds and calls no model.</p>
        ) : (
          <p className="text-[15px] leading-relaxed text-zinc-800">
            <strong className="font-semibold">
              {expected} of {judged.length}
            </strong>{" "}
            suggestions came out as expected. Grouping by location alone would have closed{" "}
            <strong className="font-semibold text-rose-700">
              {buriedByLocation} of {attention.length}
            </strong>{" "}
            reports that needed a person (a new problem, a recurrence, an emergency) as duplicates. CiviFold closed{" "}
            <strong className="font-semibold">{buriedByUs === 0 ? "none" : buriedByUs}</strong>.
          </p>
        )}
        <div className="mt-4 flex flex-wrap items-center gap-3">
          <button
            onClick={runAll}
            disabled={running || !loaded}
            className={`rounded-lg px-4 py-2 text-sm font-semibold disabled:opacity-60 ${empty ? "bg-zinc-900 text-white hover:bg-zinc-800" : "border border-zinc-300 bg-white text-zinc-900 hover:bg-zinc-100"}`}
          >
            {running ? `Running ${done} of ${auto.length} steps…` : empty ? "Run all seven cases" : "Run everything again from the start"}
          </button>
          <span className="text-sm text-zinc-500">
            {failure ? <span className="text-rose-700">{failure}</span> : "Shared with other visitors; one run a minute."}
          </span>
          <Link href="/admin" className="ml-auto text-sm font-medium text-zinc-900 underline underline-offset-2">
            Open the staff console →
          </Link>
        </div>
        {running && (
          <div className="mt-3 h-1 overflow-hidden rounded-full bg-zinc-200">
            <div className="h-full rounded-full bg-zinc-900 transition-[width] duration-500" style={{ width: `${Math.max(4, (done / auto.length) * 100)}%` }} />
          </div>
        )}
      </section>

      {scenarios.map((sc, n) => (
        <section key={sc.id} className="overflow-hidden rounded-2xl border border-zinc-200">
          <header className="px-5 pb-3 pt-4">
            <h2 className="flex items-baseline gap-3 font-semibold">
              <span className="font-mono text-xs text-zinc-400">{String(n + 1).padStart(2, "0")}</span>
              {sc.title}
            </h2>
            <p className="mt-1 text-sm text-zinc-600">{sc.story}</p>
            {sc.world.map((w) => (
              <div key={w.title} className="mt-3 flex items-center gap-3 text-sm text-zinc-600">
                <div className="w-20 shrink-0">
                  <Thumb src={w.photo} alt={`Open incident: ${w.title}`} />
                </div>
                <span>
                  Already open: <span className="font-medium text-zinc-900">{w.title}</span>, reported three days before.
                </span>
              </div>
            ))}
          </header>
          <ol className="divide-y divide-zinc-100 border-t border-zinc-100">
            {sc.steps.map((st, i) => {
              const r = results[`${sc.id}:${i}`];
              const owner = ownerIndex(sc.steps, i);
              const ownerResult = owner >= 0 ? results[`${sc.id}:${owner}`] : undefined;
              return (
                <li key={i} className={`px-5 py-4 transition-opacity ${r || st.kind === "decide" ? "" : "opacity-45"}`}>
                  {sends(st) ? <SentRow st={st} r={r} running={running} /> : <ActionRow st={st} r={r} owner={ownerResult} running={running} />}
                </li>
              );
            })}
          </ol>
        </section>
      ))}
    </div>
  );
}

// A report, message or answer: what was sent, what location alone would do, and what CiviFold suggested.
function SentRow({ st, r, running }: { st: StepView; r: StepResult | undefined; running: boolean }) {
  const buried = needsAttention(st) && r?.location_only?.label === "DUPLICATE";
  return (
    <div className="grid gap-4 sm:grid-cols-[140px_minmax(0,1fr)]">
      <div className="hidden sm:block">
        {st.photo ? (
          <Thumb src={st.photo} alt={st.text} />
        ) : (
          <div className="flex aspect-[3/2] items-center justify-center rounded-lg border border-dashed border-zinc-300 text-xs font-medium text-zinc-500">
            {st.message?.kind === "voice" ? "Voice, no photo" : "Text, no photo"}
          </div>
        )}
      </div>
      <div className="min-w-0">
        <p className="text-sm font-medium text-zinc-900">{st.text}</p>
        {st.message && <p className="mt-1 border-l-2 border-zinc-200 pl-2 text-sm italic text-zinc-700">“{st.message.text}”</p>}
        {st.message?.audio && <audio controls preload="none" src={st.message.audio} className="mt-1.5 h-8 w-full max-w-xs" />}
        <dl className="mt-3 grid grid-cols-[104px_minmax(0,1fr)] items-center gap-x-3 gap-y-1.5 text-sm">
          <dt className="text-zinc-500">Location only</dt>
          <dd className="flex flex-wrap items-center gap-x-2 gap-y-1">
            {r?.location_only ? (
              <>
                <LabelBadge label={r.location_only.label} />
                {r.location_only.incident_id && <span className="font-mono text-xs text-zinc-500">{r.location_only.incident_id}</span>}
                {buried && <span className="text-xs font-medium text-rose-700">✕ would close a report that needs a person</span>}
              </>
            ) : (
              <span className="text-zinc-400">{running ? "…" : "n/a"}</span>
            )}
          </dd>
          <dt className="text-zinc-500">CiviFold</dt>
          <dd className="flex flex-wrap items-center gap-x-2 gap-y-1">
            {r?.label ? (
              <>
                {st.urgent && <UrgentBadge />}
                <LabelBadge label={r.label} />
                {r.incident_id && <span className="font-mono text-xs text-zinc-500">{r.incident_id}</span>}
                {st.expect &&
                  (r.label === st.expect ? (
                    <span className="text-xs font-medium text-emerald-700">✓ as expected</span>
                  ) : (
                    <span className="text-xs font-medium text-amber-700">
                      expected <LabelBadge label={st.expect} />
                    </span>
                  ))}
              </>
            ) : (
              <span className="text-zinc-400">{running ? "running…" : "not run yet"}</span>
            )}
          </dd>
        </dl>
        <div className="mt-2 flex flex-wrap items-baseline gap-x-4 gap-y-1">
          <p className="min-w-0 flex-1 text-xs text-zinc-500">{st.why}</p>
          {r?.report_id && <ViewLinks r={r} />}
        </div>
      </div>
    </div>
  );
}

// A step that sends nothing: a repair, a check by an agent, or the staff decision left to the visitor.
function ActionRow({ st, r, owner, running }: { st: StepView; r: StepResult | undefined; owner: StepResult | undefined; running: boolean }) {
  let body: ReactNode;
  if (st.kind === "repair") body = r?.done ? <span className="text-emerald-700">Recorded.</span> : null;
  else if (st.kind === "verify") body = r?.label ? <span className="inline-flex items-center gap-1.5">The agent kept <LabelBadge label={r.label} /></span> : null;
  else if (st.kind === "brief")
    body = r?.brief ? (
      <span className={r.brief.status === "written" ? "text-emerald-700" : "text-amber-700"}>
        {r.brief.status === "written" ? `Written: ${r.brief.kept} items, every one citing evidence.` : "Not finished; its reads are on the staff view."}
      </span>
    ) : null;
  else if (st.kind === "decide")
    body = r?.decided ? (
      <span className="text-emerald-700">Linked to {r.decided.incident_id} by staff. The resident&apos;s page says Decided.</span>
    ) : owner?.report_id ? (
      <Link href={`/admin/reports/${owner.report_id}`} className="font-semibold text-zinc-900 underline underline-offset-2">
        Your turn: approve it in the staff view →
      </Link>
    ) : null;
  const tag = { repair: "Staff", verify: "Agent", brief: "Agent", decide: "You, as staff", report: "", message: "", answer: "" }[st.kind];
  return (
    <div className="grid gap-x-4 gap-y-1 sm:grid-cols-[140px_minmax(0,1fr)]">
      <span className="hidden self-start rounded-md bg-zinc-100 px-2 py-1 text-center text-xs font-medium text-zinc-600 sm:block">{tag}</span>
      <div className="min-w-0">
        <p className="text-sm">
          <span className="font-medium text-zinc-900">{st.text}</span>
          {body ? <span className="ml-2">{body}</span> : !r && st.kind !== "decide" && <span className="ml-2 text-zinc-400">{running ? "running…" : "not run yet"}</span>}
        </p>
        <div className="mt-1 flex flex-wrap items-baseline gap-x-4 gap-y-1">
          <p className="min-w-0 flex-1 text-xs text-zinc-500">{st.why}</p>
          {r?.report_id && st.kind !== "decide" && <ViewLinks r={r} />}
        </div>
      </div>
    </div>
  );
}

function ViewLinks({ r }: { r: StepResult }) {
  return (
    <span className="flex shrink-0 gap-3 text-sm">
      <Link href={`/admin/reports/${r.report_id}`} className="font-medium text-zinc-900 underline underline-offset-2">
        Staff view
      </Link>
      <Link href={`/track/${r.tracking_code}`} className="text-zinc-600 underline underline-offset-2">
        Resident view
      </Link>
    </span>
  );
}
