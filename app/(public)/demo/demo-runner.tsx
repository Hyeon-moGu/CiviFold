// Author: HyeonMo Gu
// Created: 2026-10-27

"use client";

import Link from "next/link";
import { LinkPending } from "@/app/_ui/link-pending";
import { useCallback, useEffect, useState, type ReactNode } from "react";
import type { Label } from "@/lib/tools/types";
import { SyntheticBadge, UrgentBadge } from "@/app/_ui/labels";

export type CaseView = {
  key: string; // the scenario step that sends the case's report
  title: string;
  context: string;
  evidence: string;
  incident: { photo: string; caption: string };
  report: { photo: string; caption: string };
  expect: Label;
  noun: string; // what SAM cuts out, for the stages shown while it runs
  boxed?: boolean; // road damage or a pile: Muse Spark boxes it before SAM cuts it out
  approve?: string; // the staff decision step left to the visitor
  agent?: string; // what a Muse Spark agent can do for this report in the staff view
  verifyKey?: string; // the scenario step whose recorded agent check this case can show
};
type Cutout = { crop: string; mask: string | null; width: number; height: number };
export type OtherView = {
  key: string;
  then?: string; // a later step on the same report (an answer to the question it was asked)
  send: string;
  thenSend?: string;
  thenPhoto?: string; // the photo the resident answers with
  thenExpect?: Label; // the right answer once the resident has answered
  what: string;
  note: string;
  photo?: string;
  kind?: "voice" | "text";
  quote?: string; // what the resident said or typed
  audio?: string | null;
  urgent?: boolean;
  expect: Label;
};
type Sent = {
  report_id?: string;
  tracking_code?: string;
  label?: Label;
  location_only?: { label: Label; incident_id: string | null };
  decided?: { action: string; incident_id: string | null };
  transcript?: string;
  seen?: string[]; // what the comparison model wrote, in its own words
  asked?: string; // the question the resident was asked
  run?: { live: boolean; usd: number; ms: number }; // how the check ran: live, or replayed
  wantedLive?: boolean; // the visitor asked for a live run (a replay then means today's budget was spent)
  recorded?: Label; // the answer shown before a live run, to set the live answer beside
  agent?: { checks: number; matching: number; ruledOut: number; against: number }; // what the verification agent checked
  briefed?: number; // cited items in the case brief staff asked for
  cutout?: Cutout; // what SAM 3.1 cut out of the report's photo
  error?: string;
};

// Each answer in words a first-time visitor reads without the label names; the dot carries the console's colors.
const PLAIN: Record<Label, { text: string; dot: string }> = {
  DUPLICATE: { text: "Same problem: merge it", dot: "bg-sky-500" },
  LATE_REPORT: { text: "Late report: merge it", dot: "bg-sky-500" },
  ALREADY_RESOLVED: { text: "Already fixed: close it", dot: "bg-sky-500" },
  NEW: { text: "New problem: keep it open", dot: "bg-zinc-400" },
  POSSIBLE_RECURRENCE: { text: "Possible recurrence: keep it apart", dot: "bg-rose-500" },
  NEEDS_INFO: { text: "Ask the resident first", dot: "bg-amber-500" },
  HUMAN_REVIEW: { text: "Send to staff", dot: "bg-amber-500" },
};
const MERGES: ReadonlySet<Label> = new Set(["DUPLICATE", "LATE_REPORT", "ALREADY_RESOLVED"]);
const DECIDED_TEXT: Record<string, string> = {
  link: "merged into the incident",
  recurrence: "kept apart as a recurrence",
  new_incident: "opened as a new incident",
  request_info: "asked the resident",
  dismiss: "dismissed",
};

// A report that needs a person (a new problem, a recurrence, an emergency) is buried when merged as a repeat.
const buries = (expect: Label, urgent: boolean, got: Label | undefined) => (expect === "NEW" || expect === "POSSIBLE_RECURRENCE" || urgent) && got === "DUPLICATE";

type Mark = { text: string; tone: string } | null;
function locationMark(expect: Label, got: Label | undefined): Mark {
  if (!got) return null;
  if (buries(expect, false, got)) return { text: "✕ buries a report that needs a person", tone: "text-rose-700" };
  if (got === expect) return { text: "✓ right call here", tone: "text-emerald-700" };
  if (MERGES.has(got) && MERGES.has(expect)) return { text: "≈ also merges it, which is right here", tone: "text-zinc-500" };
  return null;
}
const civifoldMark = (expect: Label, got: Label | undefined): Mark =>
  !got ? null : got === expect ? { text: "✓ right call", tone: "text-emerald-700" } : { text: "differs from the right call for this case", tone: "text-amber-700" };

// What a sent report goes through. A replay steps through it at a reading pace. A live run reports no progress
// from the server, so it lists the stages and the time taken, without pretending to know which one is running.
const STAGE_MS = 550;

// Keeps a run's progress on screen when the button that started it sat near the bottom edge.
const reveal = (el: HTMLElement | null) => el?.scrollIntoView({ block: "nearest", behavior: "smooth" });
const stagesFor = (noun: string, boxed = false) => [
  "Reading the photo with Muse Spark",
  boxed ? `Boxing the ${noun} with Muse Spark, cutting it out with SAM 3.1` : `Cutting out the ${noun} with SAM 3.1`,
  "Comparing it with the incident on file",
  "Applying the time and repair rules",
];

// What this visitor sent is kept for the tab, so a trip to the staff view and back keeps the answers.
const STORE = "civifold-demo-sent";
function loadSent(): Record<string, Sent> {
  try {
    return JSON.parse(sessionStorage.getItem(STORE) ?? "{}") as Record<string, Sent>;
  } catch {
    return {};
  }
}
function saveSent(sent: Record<string, Sent>) {
  try {
    sessionStorage.setItem(STORE, JSON.stringify(sent));
  } catch {
    // Storage blocked: the answers stay until the page is left.
  }
}

async function sendStep(key: string, live: boolean): Promise<Sent> {
  const [scenario, step] = key.split(":");
  try {
    const res = await fetch("/api/demo/step", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ scenario, step: Number(step), live }),
    });
    const body = (await res.json().catch(() => ({}))) as Sent;
    return res.ok ? body : { error: body.error ?? "Could not send it." };
  } catch {
    return { error: "Could not reach the server." };
  }
}

function Plain({ label, size = "lg", urgent = false }: { label: Label; size?: "lg" | "sm"; urgent?: boolean }) {
  const p = urgent && label === "HUMAN_REVIEW" ? { text: "Urgent: top of the staff queue", dot: "bg-red-600" } : PLAIN[label];
  return (
    <span className={`inline-flex items-center gap-2 font-semibold text-zinc-900 ${size === "lg" ? "text-[16px]" : "text-[13px]"}`}>
      <span className={`h-2.5 w-2.5 shrink-0 rounded-full ${p.dot}`} />
      {p.text}
    </span>
  );
}

function Photo({ src, caption, cutout }: { src: string; caption: string; cutout?: Cutout }) {
  return (
    <figure>
      <div className="relative overflow-hidden rounded-xl border border-zinc-200 bg-zinc-100">
        {/* eslint-disable-next-line @next/next/no-img-element -- resized by our image route */}
        <img src={src} alt={caption} loading="lazy" className="block aspect-[3/2] w-full object-cover" />
        {cutout?.mask && (
          // The path is built on our server from SAM's mask, in the photo's pixels; "slice" crops it as object-cover crops the photo.
          <svg viewBox={`0 0 ${cutout.width} ${cutout.height}`} preserveAspectRatio="xMidYMid slice" className="pointer-events-none absolute inset-0 h-full w-full">
            <g fill="none" stroke="rgba(0,0,0,0.6)" strokeWidth={4} className="[&_path]:[vector-effect:non-scaling-stroke]" dangerouslySetInnerHTML={{ __html: cutout.mask }} />
            <g fill="rgba(255,255,255,0.12)" stroke="#ffffff" strokeWidth={1.5} className="[&_path]:[vector-effect:non-scaling-stroke]" dangerouslySetInnerHTML={{ __html: cutout.mask }} />
          </svg>
        )}
        <span className="absolute left-2 top-2">
          <SyntheticBadge />
        </span>
        {cutout?.mask && <span className="absolute bottom-2 right-2 rounded bg-black/70 px-1.5 py-0.5 font-mono text-[10px] text-white">outlined by SAM 3.1</span>}
      </div>
      <figcaption className="mt-1.5 text-xs text-zinc-600 sm:text-sm">{caption}</figcaption>
    </figure>
  );
}

// What the verification agent did, in one line, as a visitor back from the staff view reads it.
function checkText(a: { checks: number; matching: number; ruledOut: number; against: number }, who = "Agent check in the staff view"): string {
  const parts = [`${a.checks} check${a.checks === 1 ? "" : "s"}`];
  if (a.matching) parts.push(`${a.matching} matching`);
  if (a.ruledOut) parts.push(`${a.ruledOut} look-alike${a.ruledOut === 1 ? "" : "s"} ruled out`);
  return a.against ? `${who}: ${parts.join(", ")}, ${a.against} against. Look at those before approving.` : `${who}: ${parts.join(", ")}, none against.`;
}

// How long the live run has taken so far.
function Elapsed({ since }: { since: number }) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);
  const seconds = since ? Math.max(0, Math.floor((now - since) / 1000)) : 0;
  return (
    <p className="mt-2 font-mono text-xs text-zinc-500">
      Usually 20 seconds to a minute · {Math.floor(seconds / 60)}:{String(seconds % 60).padStart(2, "0")}
    </p>
  );
}

// Seconds since a run started, ticking.
function Seconds({ since }: { since: number }) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);
  return <span className="font-mono text-xs text-zinc-500">{since ? Math.max(0, Math.floor((now - since) / 1000)) : 0} s</span>;
}

// How the answer came about: replayed (with a button to run it live), or live with what it cost and took, set
// beside the recorded answer when the live one differs.
function RunLine({
  sent,
  className = "",
  onLive,
  compare,
}: {
  sent?: Pick<Sent, "run" | "wantedLive" | "recorded" | "label">;
  className?: string;
  onLive?: () => void;
  compare?: (label: Label) => ReactNode;
}) {
  const run = sent?.run;
  if (!run) return null;
  const live = (
    <button onClick={onLive} className="ml-2 rounded-md border border-zinc-300 bg-white px-2 py-0.5 font-sans text-xs font-medium text-zinc-900 hover:bg-zinc-50">
      Run it live
    </button>
  );
  if (!run.live) {
    return (
      <p className={`flex flex-wrap items-center gap-y-1 font-mono text-xs text-zinc-500 ${className}`}>
        {sent?.wantedLive ? "Today's live budget is used up, so this replayed the recorded run." : "Replayed a recorded run, in seconds."}
        {onLive && !sent?.wantedLive && live}
      </p>
    );
  }
  return (
    <div className={`text-xs text-zinc-500 ${className}`}>
      <p className="flex flex-wrap items-center gap-y-1 font-mono">
        Ran live just now on Muse Spark and SAM 3.1 · ${run.usd.toFixed(3)} · {(run.ms / 1000).toFixed(1)} s{onLive && live}
      </p>
      {sent?.recorded && sent.label && sent.recorded !== sent.label && compare && (
        <p className="mt-1 flex flex-wrap items-center gap-2">
          <span>The recorded run said</span>
          {compare(sent.recorded)}
          <span>Model answers can vary between runs; staff see both and decide.</span>
        </p>
      )}
    </div>
  );
}

function Spinner() {
  return <span aria-hidden className="inline-block h-3.5 w-3.5 shrink-0 animate-spin rounded-full border-2 border-zinc-400 border-r-transparent" />;
}

export function DemoRunner({ cases, others }: { cases: CaseView[]; others: OtherView[] }) {
  const [sent, setSent] = useState<Record<string, Sent>>({});
  const [ready, setReady] = useState(false); // what this tab sent is read after the first render
  const [world, setWorld] = useState<Record<string, Sent>>({});
  const [busy, setBusy] = useState<Record<string, number>>({}); // key -> stages shown so far while it runs
  const [startedAt, setStartedAt] = useState<Record<string, number>>({});
  const [liveRun, setLiveRun] = useState<Record<string, boolean>>({}); // key -> whether its current run is live
  const [resetting, setResetting] = useState(false);
  const [resetNote, setResetNote] = useState<string | null>(null);

  const readWorld = useCallback(async () => {
    const res = await fetch("/api/demo/state", { cache: "no-store" });
    if (res.ok) setWorld((await res.json()) as Record<string, Sent>);
  }, []);

  useEffect(() => {
    let active = true;
    (async () => {
      const mine = loadSent();
      try {
        const res = await fetch("/api/demo/state", { cache: "no-store" });
        if (!res.ok || !active) return;
        const state = (await res.json()) as Record<string, Sent>;
        setWorld(state);
        // Answers from before a reset point at reports that no longer exist.
        const alive = new Set(Object.values(state).map((r) => r.report_id));
        const kept = Object.fromEntries(Object.entries(mine).filter(([, r]) => r.report_id && alive.has(r.report_id)));
        setSent(kept);
        saveSent(kept);
      } catch {
        if (active) setSent(mine);
      } finally {
        if (active) setReady(true);
      }
    })();
    return () => {
      active = false;
    };
  }, []);

  async function send(key: string, stages: number, live = false) {
    // A live run is compared with the answer shown before it: the recorded run, or the visitor's last send.
    const before = sent[key]?.label ?? world[key]?.label;
    setBusy((b) => ({ ...b, [key]: 0 }));
    setStartedAt((t) => ({ ...t, [key]: Date.now() }));
    setLiveRun((l) => ({ ...l, [key]: live }));
    const ticks = live ? [] : Array.from({ length: stages }, (_, i) => setTimeout(() => setBusy((b) => (key in b ? { ...b, [key]: i + 1 } : b)), (i + 1) * STAGE_MS));
    const [answer] = await Promise.all([sendStep(key, live), new Promise((r) => setTimeout(r, live ? 1200 : stages * STAGE_MS + 200))]);
    const result: Sent = { ...answer, wantedLive: live, ...(live && before ? { recorded: before } : {}) };
    ticks.forEach(clearTimeout);
    setBusy((b) => {
      const next = { ...b };
      delete next[key];
      return next;
    });
    setSent((s) => {
      const next = { ...s, [key]: result };
      saveSent(next);
      return next;
    });
    readWorld().catch(() => {});
  }

  // A reset plays every case again on the server, so the staff console is never empty.
  async function resetWorld() {
    setResetting(true);
    setResetNote(null);
    try {
      const res = await fetch("/api/demo/reset", { method: "POST" });
      const body = (await res.json().catch(() => ({}))) as { error?: string };
      if (!res.ok) setResetNote(body.error ?? "The reset failed. Try again.");
      else {
        setSent({});
        saveSent({});
        setResetNote("The demo world is back to its starting state.");
      }
    } catch {
      setResetNote("Could not reach the server.");
    } finally {
      await readWorld().catch(() => {});
      setResetting(false);
    }
  }

  // Every case not yet sent, all at once. The first case keeps the recorded run it opens with.
  const unsent = cases.filter((c, i) => !sent[c.key] && !(c.key in busy) && !(i === 0 && world[c.key]?.label));
  const [batch, setBatch] = useState<string[]>([]);
  const batchDone = batch.filter((k) => !(k in busy)).length;
  const batchRunning = batch.length > 0 && batchDone < batch.length;
  const sendAll = () => {
    setBatch(unsent.map((c) => c.key));
    unsent.forEach((c) => void send(c.key, stagesFor(c.noun, c.boxed).length));
  };

  return (
    <div className="mt-8 space-y-8">
      {ready && (batchRunning || unsent.length > 1) && (
        <div
          className={`flex flex-col items-start gap-3 rounded-xl border border-zinc-200 bg-zinc-50/95 px-4 py-3 backdrop-blur sm:flex-row sm:items-center ${batchRunning ? "sticky top-16 z-10" : ""}`}
        >
          {batchRunning ? (
            <p className="flex items-center gap-2 text-sm font-medium text-zinc-800" role="status">
              <Spinner /> Sending: {batchDone} of {batch.length} done
            </p>
          ) : (
            <>
              <button onClick={sendAll} className="shrink-0 rounded-lg bg-zinc-900 px-4 py-2 text-sm font-semibold text-white hover:bg-zinc-800">
                Send the other {unsent.length} reports at once
              </button>
              <p className="text-sm text-zinc-600">Each replays its recorded run in seconds. &ldquo;Run it live&rdquo; on any card then calls Muse Spark and SAM 3.1 now.</p>
            </>
          )}
        </div>
      )}
      {cases.map((c, i) => {
        // The first case shows the demo world's own run until the visitor sends theirs.
        const preview = i === 0 && !sent[c.key] && !(c.key in busy) && world[c.key]?.label ? world[c.key] : undefined;
        const r = sent[c.key] ?? preview;
        const running = c.key in busy;
        const done = Boolean(r?.label) && !running;
        const stages = stagesFor(c.noun, c.boxed);
        const lo = locationMark(c.expect, r?.location_only?.label);
        const cf = civifoldMark(c.expect, r?.label);
        const approved = c.approve && r?.report_id && world[c.approve]?.report_id === r.report_id && world[c.approve]?.decided;
        // The world's record of this very report: the agent check and brief staff asked for in the staff view.
        const mine = r?.report_id && world[c.key]?.report_id === r.report_id ? world[c.key] : undefined;
        // What the agent did on the case's recorded run, until the visitor runs it on their own report.
        const recordedCheck = c.verifyKey ? world[c.verifyKey]?.agent : undefined;
        // Any staff decision on this report, the guided approval or one made in the staff view.
        const decision = (approved ? world[c.approve!]?.decided : undefined) ?? (r?.report_id && world[c.key]?.report_id === r.report_id ? world[c.key]?.decided : undefined);
        return (
          <article key={c.key} id={`case-${c.key.replace(":", "-")}`} className="scroll-mt-20 overflow-hidden rounded-2xl border border-zinc-200 bg-white">
            <header className="flex items-start gap-3 px-5 pt-5">
              <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-zinc-900 text-sm font-semibold text-white">{i + 1}</span>
              <div>
                <h2 className="text-xl font-semibold tracking-tight">{c.title}</h2>
                <p className="mt-0.5 text-[15px] text-zinc-600">{c.context}</p>
              </div>
            </header>
            <div className="mt-4 grid grid-cols-2 gap-2 px-5 sm:gap-4">
              <Photo src={c.incident.photo} caption={c.incident.caption} />
              <Photo src={c.report.photo} caption={c.report.caption} cutout={done && typeof r?.cutout === "object" ? r.cutout : undefined} />
            </div>

            {running ? (
              <div ref={reveal} className="mx-5 mt-4 rounded-xl border border-zinc-200 bg-zinc-50 px-4 py-3" role="status" aria-live="polite">
                {liveRun[c.key] ? (
                  <>
                    <p className="flex items-center gap-2 text-sm font-medium text-zinc-900">
                      <Spinner /> Running live on Muse Spark and SAM 3.1, in this order:
                    </p>
                    <ol className="mt-1.5 list-decimal space-y-0.5 pl-10 text-sm text-zinc-600">
                      {stages.map((s) => (
                        <li key={s}>{s}</li>
                      ))}
                    </ol>
                    <Elapsed since={startedAt[c.key] ?? 0} />
                  </>
                ) : (
                  <>
                    <ol className="space-y-1.5 text-sm">
                      {stages.map((s, n) => {
                        const shown = busy[c.key] ?? 0;
                        return (
                          <li key={s} className={`flex items-center gap-2 ${n <= shown ? "text-zinc-900" : "text-zinc-400"}`}>
                            {n < shown ? <span className="w-3.5 text-center text-emerald-600">✓</span> : n === shown ? <Spinner /> : <span className="w-3.5" />}
                            {s}
                          </li>
                        );
                      })}
                    </ol>
                    <p className="mt-2 text-xs text-zinc-500">Replaying the recorded model calls for this photo.</p>
                  </>
                )}
              </div>
            ) : done ? (
              <>
                <div className="mt-4 grid gap-3 px-5 sm:grid-cols-2">
                  <div className="rounded-xl border border-zinc-200 bg-zinc-50 px-4 py-3">
                    <p className="text-sm text-zinc-500">Location only would say</p>
                    <div className="mt-1">{r?.location_only && <Plain label={r.location_only.label} />}</div>
                    {lo && <p className={`mt-1 text-sm font-medium ${lo.tone}`}>{lo.text}</p>}
                  </div>
                  <div className="rounded-xl border border-zinc-300 bg-white px-4 py-3 shadow-sm">
                    <p className="text-sm text-zinc-500">CiviFold suggests</p>
                    <div className="mt-1">
                      <Plain label={r!.label!} />
                    </div>
                    {cf && <p className={`mt-1 text-sm font-medium ${cf.tone}`}>{cf.text}</p>}
                  </div>
                </div>
                {/* The case's own explanation fits the answer it expects; a live run that came out otherwise says so. */}
                <p className="mt-4 px-5 text-[15px] text-zinc-800">
                  {r?.label === c.expect || !r?.run?.live
                    ? c.evidence
                    : "This live run came out differently from the recorded one: the models' answers can vary between runs. Staff see the evidence below and decide."}
                </p>
                <RunLine
                  sent={preview ? { run: { live: false, usd: 0, ms: 0 } } : r}
                  className="mx-5 mt-2"
                  onLive={() => send(c.key, stages.length, true)}
                  compare={(label) => <Plain label={label} size="sm" />}
                />
                {r?.seen && r.seen.length > 0 && (
                  // Open on the first two cards; the later ones keep it a click away so the page stays short.
                  <details open={i < 2} className="group mx-5 mt-3 rounded-lg bg-zinc-50 px-4 py-3">
                    <summary className="cursor-pointer list-none text-xs font-medium text-zinc-500 [&::-webkit-details-marker]:hidden">
                      <span className="mr-1 inline-block transition-transform group-open:rotate-90">›</span>
                      What Muse Spark wrote, comparing the two photos
                    </summary>
                    <div className="mt-2 flex gap-4">
                      {typeof r.cutout === "object" && (
                        <figure className="w-20 shrink-0">
                          {/* eslint-disable-next-line @next/next/no-img-element -- resized by our image route */}
                          <img src={`/api/images/${r.cutout.crop}?w=160`} alt={`SAM 3.1 cut-out of the ${c.noun}`} className="h-24 w-20 rounded border border-zinc-200 bg-white object-contain" />
                          <figcaption className="mt-1 text-[11px] leading-tight text-zinc-500">Cut out by SAM 3.1</figcaption>
                        </figure>
                      )}
                      <ul className="min-w-0 space-y-0.5 text-sm text-zinc-700">
                        {r.seen.map((line) => (
                          <li key={line} className="flex gap-2">
                            <span className="mt-2 h-1 w-1 shrink-0 rounded-full bg-zinc-400" />
                            {line}
                          </li>
                        ))}
                      </ul>
                    </div>
                  </details>
                )}
                {mine?.agent ? (
                  <p className="mx-5 mt-3 flex gap-2 text-sm text-zinc-700">
                    <span aria-hidden className="mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full bg-violet-500" />
                    <span>{checkText(mine.agent)}</span>
                  </p>
                ) : recordedCheck && !decision ? (
                  <p className="mx-5 mt-3 flex gap-2 text-sm text-zinc-700">
                    <span aria-hidden className="mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full bg-violet-500" />
                    <span>
                      {checkText(recordedCheck, "Recorded agent check")} Try &ldquo;Verify with the agent&rdquo; in the staff view.
                    </span>
                  </p>
                ) : (
                  c.agent &&
                  !decision &&
                  !mine?.briefed && (
                    <p className="mx-5 mt-3 flex gap-2 text-sm text-zinc-600">
                      <span aria-hidden className="mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full bg-violet-500" />
                      <span>{c.agent}</span>
                    </p>
                  )
                )}
                {mine?.briefed ? (
                  <p className="mx-5 mt-1.5 flex gap-2 text-sm text-zinc-700">
                    <span aria-hidden className="mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full bg-violet-500" />
                    <span>Case brief for staff: {mine.briefed} items, each citing a fact or a tool result.</span>
                  </p>
                ) : null}
              </>
            ) : !ready ? (
              <div className="mx-5 mt-4 h-[74px] rounded-xl border border-dashed border-zinc-200" />
            ) : (
              <div className="mx-5 mt-4 flex flex-col items-start gap-3 rounded-xl border border-dashed border-zinc-300 px-4 py-4 sm:flex-row sm:items-center">
                <p className="min-w-0 flex-1 text-[15px] text-zinc-700">Same problem, or not? Send the report to see what location alone does and what CiviFold suggests.</p>
                <button onClick={() => send(c.key, stages.length)} className="shrink-0 rounded-lg bg-zinc-900 px-4 py-2 text-sm font-semibold text-white hover:bg-zinc-800">
                  Send this report
                </button>
              </div>
            )}
            {r?.error && !running && <p className="mx-5 mt-3 text-sm text-rose-700">{r.error}</p>}

            <div className="mt-5 flex flex-wrap items-center gap-x-5 gap-y-2 border-t border-zinc-100 bg-zinc-50 px-5 py-3 text-sm">
              {done && r?.report_id ? (
                <>
                  {decision ? (
                    <span className="text-emerald-700">
                      ✓ Decided by staff: {DECIDED_TEXT[decision.action] ?? decision.action}.{" "}
                      <Link href={`/track/${r.tracking_code}`} className="underline underline-offset-2 hover:text-emerald-900">
                        The resident&apos;s page
                      </Link>{" "}
                      now says so.
                    </span>
                  ) : c.approve ? (
                    <Link href={`/admin/reports/${r.report_id}`} className="rounded-lg bg-zinc-900 px-3 py-1.5 font-semibold text-white hover:bg-zinc-800">
                      Open it in the staff view to approve →
                      <LinkPending className="ml-1.5 align-[-2px]" />
                    </Link>
                  ) : (
                    <Link href={`/admin/reports/${r.report_id}`} className="font-medium text-zinc-900 underline underline-offset-2">
                      See it in the staff view →
                      <LinkPending className="ml-1.5 align-[-2px]" />
                    </Link>
                  )}
                  {!preview && (
                    <button onClick={() => send(c.key, stages.length)} className="ml-auto text-zinc-500 underline underline-offset-2 hover:text-zinc-900">
                      Send it again
                    </button>
                  )}
                </>
              ) : (
                <span className="text-zinc-500">Your report goes to the staff console, where staff decide.</span>
              )}
            </div>
          </article>
        );
      })}

      {/* Closed until the visitor opens it or has sent one of its reports, so the page stays short. */}
      <details open={others.some((o) => sent[o.key] || o.key in busy)} className="group">
        <summary className="cursor-pointer list-none rounded-xl border border-zinc-200 bg-white px-4 py-3 hover:bg-zinc-50 [&::-webkit-details-marker]:hidden">
          <span className="flex items-baseline gap-2">
            <span aria-hidden className="inline-block text-zinc-500 transition-transform group-open:rotate-90">›</span>
            <span className="text-xl font-semibold tracking-tight">When the right answer is to ask</span>
          </span>
          <span className="mt-1 block pl-4 text-[15px] text-zinc-600">
            A voice message, a possible emergency, a noise complaint and two photos that do not show the place. CiviFold asks, or hands them to a person.
          </span>
        </summary>
        <ul className="mt-4 grid gap-3 sm:grid-cols-2">
          {others.map((o) => {
            const r = sent[o.key];
            const then = o.then ? sent[o.then] : undefined;
            const running = o.key in busy || (o.then ? o.then in busy : false);
            const buried = buries(o.expect, Boolean(o.urgent), r?.location_only?.label);
            const answerable = o.then && r?.label === "NEEDS_INFO" && !then?.label;
            // A live run can come out otherwise than the card describes; it is said, not hidden.
            const differs = Boolean((r?.label && r.label !== o.expect) || (then?.label && o.thenExpect && then.label !== o.thenExpect));
            return (
              <li key={o.key} id={`case-${o.key.replace(":", "-")}`} className="flex scroll-mt-20 gap-3 rounded-xl border border-zinc-200 p-3">
                <div className="w-24 shrink-0">
                  {o.photo ? (
                    <div className="relative overflow-hidden rounded-lg border border-zinc-200">
                      {/* eslint-disable-next-line @next/next/no-img-element -- resized by our image route */}
                      <img src={o.photo.replace("w=960", "w=240")} alt={o.what} loading="lazy" className="block aspect-[3/2] w-full object-cover" />
                      <span className="absolute left-1 top-1 origin-top-left scale-75">
                        <SyntheticBadge />
                      </span>
                    </div>
                  ) : (
                    <div className="flex aspect-[3/2] items-center justify-center rounded-lg border border-dashed border-zinc-300 text-xs font-medium text-zinc-500">
                      {o.kind === "voice" ? "Voice" : "Text"}
                    </div>
                  )}
                </div>
                <div className="min-w-0 flex-1 text-sm">
                  <p className="flex flex-wrap items-center gap-2 font-medium text-zinc-900">
                    {o.what}
                    {o.urgent && <UrgentBadge />}
                  </p>
                  {o.quote && !r?.transcript && <p className="mt-1 border-l-2 border-zinc-200 pl-2 italic text-zinc-700">“{o.quote}”</p>}
                  {o.audio && !r?.transcript && <audio controls preload="metadata" src={o.audio} className="mt-1.5 h-8 w-full max-w-xs" />}
                  {r?.transcript && (
                    <p className="mt-1 border-l-2 border-sky-300 pl-2 text-zinc-700">
                      <span className="block text-xs font-medium not-italic text-sky-700">Transcribed by Muse Voice Transcribe</span>
                      <span className="italic">“{r.transcript}”</span>
                    </p>
                  )}
                  {/* What it does is said once it has run, so the card does not give the answer away. */}
                  {r?.label && !running && !differs && <p className="mt-1 text-zinc-600">{o.note}</p>}
                  {differs && !running && (
                    <p className="mt-1 text-[13px] font-medium text-amber-700">
                      Differs from the right call for this card: this live run came out otherwise, as model answers can between runs. Staff see it and decide.
                    </p>
                  )}
                  <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1.5">
                    {running ? (
                      <span className="inline-flex items-center gap-2 text-zinc-600">
                        <Spinner />
                        {liveRun[o.then && o.then in busy ? o.then : o.key] ? (
                          <>
                            Running live… <Seconds since={startedAt[o.then && o.then in busy ? o.then : o.key] ?? 0} />
                          </>
                        ) : (
                          "Replaying the recorded run…"
                        )}
                      </span>
                    ) : r?.label ? (
                      <>
                        <Plain label={r.label} size="sm" urgent={o.urgent} />
                        {then?.label && (
                          <>
                            <span className="text-zinc-400">then, with the photo</span>
                            {o.thenPhoto && (
                              // eslint-disable-next-line @next/next/no-img-element -- resized by our image route
                              <img src={o.thenPhoto.replace("w=960", "w=120")} alt="The photo the resident answered with" className="h-12 w-[4.5rem] rounded border border-zinc-200 object-cover" />
                            )}
                            <Plain label={then.label} size="sm" />
                          </>
                        )}
                        {answerable && (
                          <button onClick={() => send(o.then!, 1, Boolean(r?.run?.live))} className="rounded-md border border-zinc-300 px-2 py-1 font-medium hover:bg-zinc-50">
                            {o.thenSend}
                          </button>
                        )}
                        {r.report_id && (
                          <Link href={`/admin/reports/${r.report_id}`} className="text-zinc-900 underline underline-offset-2">
                            See it →
                          </Link>
                        )}
                      </>
                    ) : !ready ? null : (
                      <button onClick={() => send(o.key, 1)} className="rounded-md bg-zinc-900 px-2.5 py-1 font-semibold text-white hover:bg-zinc-800">
                        {o.send}
                      </button>
                    )}
                  </div>
                  {!running && (
                    <RunLine sent={then?.run ? then : r} className="mt-1" onLive={() => send(o.key, 1, true)} compare={(label) => <Plain label={label} size="sm" />} />
                  )}
                  {r?.asked && r.label === "NEEDS_INFO" && !running && (
                    <p className="mt-1.5 rounded-md bg-amber-50 px-2 py-1 text-[13px] text-amber-900">
                      <span className="font-medium">Asked the resident:</span> “{r.asked}”
                    </p>
                  )}
                  {buried && !running && <p className="mt-1 text-xs font-medium text-rose-700">Location only would merge it into an open incident.</p>}
                  {(r?.error || then?.error) && !running && <p className="mt-1 text-xs text-rose-700">{r?.error ?? then?.error}</p>}
                </div>
              </li>
            );
          })}
        </ul>
      </details>

      <section className="flex flex-col gap-4 rounded-2xl bg-zinc-900 px-6 py-6 text-white sm:flex-row sm:items-center">
        <div className="min-w-0 flex-1">
          <h2 className="text-xl font-semibold tracking-tight">See it as staff</h2>
          <p className="mt-1 text-[15px] text-zinc-300">The reports you sent are in the staff console with their photos, SAM cut-outs and the evidence behind each suggestion.</p>
        </div>
        <div className="flex shrink-0 flex-col gap-2 sm:items-end">
          <Link href="/admin" className="rounded-lg bg-white px-4 py-2.5 text-center text-sm font-semibold text-zinc-900 hover:bg-zinc-200">
            Open the staff console →
            <LinkPending className="ml-1.5 align-[-2px]" />
          </Link>
          <Link href="/report" className="text-sm text-zinc-300 underline underline-offset-2 hover:text-white">
            Or report with a sample or your own photo
          </Link>
        </div>
      </section>

      <p className="text-center text-sm text-zinc-500">
        The demo world is shared with other visitors.{" "}
        <button onClick={resetWorld} disabled={resetting} className="font-medium text-zinc-900 underline underline-offset-2 disabled:opacity-50">
          {resetting ? "Resetting and replaying the recorded cases…" : "Reset it to the start"}
        </button>{" "}
        (once a minute).
        {resetNote && <span className="mt-1 block">{resetNote}</span>}
      </p>
    </div>
  );
}
