// Author: HyeonMo Gu
// Created: 2026-10-27

"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useRef, useState, useTransition, type ReactNode } from "react";
import type { Label, RequestItem } from "@/lib/tools/types";
import { useBrief } from "./brief";
import { Spinner, useVerify } from "./verify";
import { pauseFrom, usePaused } from "@/app/_ui/pause";

type Action = "link" | "new_incident" | "recurrence" | "request_info" | "dismiss";
// approve: the button text when this is the suggested decision, in the words the public demo uses.
type Choice = { action: Action; text: string; approve: string; needs?: boolean };

const SUGGESTED: Partial<Record<Label, Action>> = {
  DUPLICATE: "link",
  LATE_REPORT: "link",
  ALREADY_RESOLVED: "link",
  NEW: "new_incident",
  POSSIBLE_RECURRENCE: "recurrence",
};

/**
 * The decision band: the suggestion (children) beside the one decision it suggests, every other decision one
 * menu away, and the agents staff can ask for help in a row of their own. Agents never decide, so their
 * buttons never sit among the decisions.
 */
export function Actions({
  children,
  status,
  ring,
  reportId,
  analysisId,
  final,
  focusId,
  askFor,
  decided,
  stale,
  verify,
  verifyLimit,
  brief,
  briefLimit,
  agentsOff = false,
  agentsElsewhere = null,
  decidedNote = null,
  demoAnchor = null,
  caution = false,
}: {
  children: ReactNode;
  status?: ReactNode; // one line on what an agent found, under the decision
  ring: string;
  reportId: string;
  analysisId: number; // the analysis this screen shows; the server refuses a choice made on an older one
  final: { label: Label } | null;
  focusId: string | null;
  askFor: RequestItem;
  decided: boolean;
  stale: boolean; // an incident the suggestion relied on changed since: no one-click suggestion
  verify: { analysisId: number; running: boolean; again: boolean } | null; // the suggestion can be checked by the agent
  verifyLimit: number | null; // the suggestion could be checked, but this many runs is the most allowed
  brief: { analysisId: number; again: boolean } | null; // staff can ask for a case brief of this analysis
  briefLimit: number | null; // this many briefs is the most allowed
  agentsOff?: boolean; // a replay-only deployment holds no recorded agent run for this report
  agentsElsewhere?: string | null; // the report of the same demo case whose recorded agent runs can be read
  decidedNote?: ReactNode; // what the decision did
  demoAnchor?: string | null; // the demo page card this report was sent from
  caution?: boolean; // a verification found evidence against the suggestion that still stands
}) {
  const router = useRouter();
  const checking = useVerify();
  const briefing = useBrief();
  const [pending, setBusy] = useState<Action | null>(null);
  // The decision stays "Saving…" until the refreshed page that shows it has loaded.
  const [lastAction, setLastAction] = useState<Action | null>(null);
  const [refreshing, startRefresh] = useTransition();
  const saving = pending ?? (refreshing ? lastAction : null);
  const [error, setError] = useState<string | null>(null);
  const pausedStaff = usePaused("staff");
  const pausedLive = usePaused("live");
  const suggested = final && !stale ? SUGGESTED[final.label] : undefined;
  const verifying = checking?.state.phase === "running";
  const writing = briefing?.state.phase === "running";
  const busy = saving ?? (checking?.busy ? "verify" : briefing?.busy ? "brief" : null);
  // A brief only informs, so staff may decide while one is written; a check can change the suggestion, so they wait.
  const deciding = saving ?? (checking?.busy ? "verify" : null);

  async function act(action: Action) {
    setBusy(action);
    setLastAction(action);
    setError(null);
    try {
      const res = await fetch(`/api/admin/reports/${reportId}/decide`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          action,
          incident_id: action === "link" || action === "recurrence" ? focusId : null,
          item: askFor,
          analysis_id: analysisId,
          facts_changed_seen: stale,
        }),
      });
      pauseFrom(res, "staff");
      const body = (await res.json().catch(() => ({}))) as { error?: string; code?: string };
      if (!res.ok) {
        setError(body.error ?? "Could not save that.");
        // Refused because the screen was out of date: show the latest so the next choice is made on it.
        if (body.code === "stale") router.refresh();
        return;
      }
      startRefresh(() => router.refresh());
    } catch {
      // The request may or may not have reached the server: show what is stored now.
      setError("Could not confirm that it was saved (connection problem). The page was reloaded to show what is stored.");
      router.refresh();
    } finally {
      setBusy(null);
    }
  }

  const choices: Choice[] = [
    { action: "link", text: focusId ? "Merge into the incident on file" : "Merge", approve: "Approve: merge it", needs: true },
    { action: "new_incident", text: "Open a new incident", approve: "Approve: open a new incident" },
    { action: "recurrence", text: focusId ? "Open as a recurrence of the incident on file" : "Open as a recurrence", approve: "Approve: keep it apart as a recurrence", needs: true },
    { action: "request_info", text: askFor === "photo" ? "Ask for a photo" : "Ask the resident", approve: askFor === "photo" ? "Approve: ask for a photo" : "Approve: ask the resident" },
    { action: "dismiss", text: "Dismiss", approve: "Approve: dismiss" },
  ];
  const primary = choices.find((c) => c.action === suggested);
  const open = choices.filter((c) => !c.needs || focusId);
  const blocked = (c: Choice) => deciding !== null || pausedStaff || Boolean(c.needs && !focusId);
  const agents = Boolean((verify && checking) || verifyLimit !== null || (brief && briefing) || briefLimit !== null);
  const note = verifying
    ? "Decisions wait until the check finishes."
    : stale
        ? "The suggestion is out of date."
        : !primary
          ? "No one-click suggestion: choose from the evidence."
          : null;

  return (
    <section className={`rounded-lg border border-ops-line bg-ops-panel ring-1 ring-inset ${ring}`}>
      <div className="flex flex-col gap-3 px-4 py-3 xl:flex-row xl:items-center xl:gap-6">
        <div className="min-w-0 flex-1">{children}</div>
        {decided ? (
          <p className="rounded-md border border-emerald-500/30 bg-emerald-500/10 px-4 py-2 text-sm text-emerald-200">
            Decided by staff.{decidedNote && <> {decidedNote}</>}
            {demoAnchor && (
              <Link href={`/demo#${demoAnchor}`} className="ml-3 font-medium text-white underline decoration-emerald-400/60 underline-offset-2 hover:decoration-white">
                Back to the demo →
              </Link>
            )}
          </p>
        ) : (
          <div className="flex flex-wrap items-center gap-2 xl:max-w-[55%] xl:justify-end">
            {primary ? (
              <>
                <button
                  disabled={blocked(primary)}
                  onClick={() => act(primary.action)}
                  className="rounded-md bg-white px-4 py-2 text-sm font-semibold text-slate-950 transition hover:bg-zinc-200 disabled:opacity-40"
                >
                  {saving === primary.action ? "Saving…" : caution ? primary.approve.replace(/^Approve:/, "Approve anyway:") : primary.approve}
                </button>
                <OtherDecisions choices={open.filter((c) => c !== primary)} blocked={blocked} saving={saving} onPick={act} />
              </>
            ) : (
              // Nothing to accept in one click: every decision weighs the same.
              open.map((c) => (
                <button
                  key={c.action}
                  disabled={blocked(c)}
                  onClick={() => act(c.action)}
                  className="rounded-md border border-ops-line px-3 py-1.5 text-sm text-ops-text transition hover:border-ops-dim hover:bg-ops-raised disabled:opacity-40"
                >
                  {saving === c.action ? "Saving…" : c.text}
                </button>
              ))
            )}
          </div>
        )}
      </div>
      {status && <div className="border-t border-ops-line px-4 py-2 text-sm">{status}</div>}
      {!decided && (
        <footer className="flex flex-wrap items-center gap-x-3 gap-y-2 border-t border-ops-line px-4 py-2">
          {agents && <span className="text-xs text-ops-dim">Ask an agent</span>}
          {agentsOff && agentsElsewhere && (
            <Link href={`/admin/reports/${agentsElsewhere}`} className="text-xs text-violet-200 underline decoration-violet-400/50 underline-offset-2 hover:text-white">
              See the recorded agent run on the demo&apos;s own copy of this case →
            </Link>
          )}
          {verify && checking && (
            <AgentButton
              disabled={busy !== null || verify.running || pausedLive}
              running={verifying || verify.running}
              onClick={() => checking.start(verify.analysisId)}
              title="Muse Spark looks for evidence against this suggestion with the pipeline's tools. It can only make the suggestion more cautious."
            >
              {verifying || verify.running ? "Verifying…" : verify.again ? "Verify again" : "Verify with the agent"}
            </AgentButton>
          )}
          {!verify && verifyLimit !== null && (
            <span title="Each report can be verified at most this many times." className="text-xs text-ops-dim">
              Verified {verifyLimit} times (the limit)
            </span>
          )}
          {brief && briefing && (
            <AgentButton
              disabled={busy !== null || pausedLive}
              running={writing}
              onClick={() => briefing.start(brief.analysisId)}
              title="Muse Spark reads the pipeline's facts, the incident's history and what is open nearby, and writes a brief in which every item cites its evidence. It never changes the suggestion."
            >
              {writing ? "Writing…" : brief.again ? "Write a new brief" : "Write a brief"}
            </AgentButton>
          )}
          {!brief && briefLimit !== null && (
            <span title="Each report can have at most this many briefs." className="text-xs text-ops-dim">
              {briefLimit} briefs (the limit)
            </span>
          )}
          {error ? (
            <p className="text-sm text-rose-300 sm:ml-auto">{error}</p>
          ) : (
            <p className="text-xs text-ops-dim sm:ml-auto">
              {note && <span className="text-ops-text">{note} </span>}
              Nothing is merged or closed until you choose.
            </p>
          )}
        </footer>
      )}
    </section>
  );
}

function AgentButton({ children, disabled, running, onClick, title }: { children: ReactNode; disabled: boolean; running: boolean; onClick: () => void; title: string }) {
  return (
    <button
      disabled={disabled}
      onClick={onClick}
      title={title}
      className="inline-flex items-center gap-2 rounded-md border border-violet-500/40 px-2.5 py-1 text-[13px] text-violet-100 transition hover:border-violet-400 hover:bg-violet-500/15 disabled:opacity-40"
    >
      {running ? <Spinner className="h-3 w-3 text-violet-300" /> : <span aria-hidden className="h-1.5 w-1.5 rounded-full bg-violet-400" />}
      {children}
    </button>
  );
}

// The decisions the suggestion did not pick, kept one click away so the suggestion reads as the default.
function OtherDecisions({
  choices,
  blocked,
  saving,
  onPick,
}: {
  choices: Choice[];
  blocked: (c: Choice) => boolean;
  saving: Action | null;
  onPick: (a: Action) => void;
}) {
  const [open, setOpen] = useState(false);
  const box = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (!open) return;
    const away = (e: PointerEvent) => {
      if (!box.current?.contains(e.target as Node)) setOpen(false);
    };
    const key = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      setOpen(false);
      trigger.current?.focus();
    };
    document.addEventListener("pointerdown", away);
    document.addEventListener("keydown", key);
    return () => {
      document.removeEventListener("pointerdown", away);
      document.removeEventListener("keydown", key);
    };
  }, [open]);
  const pending = choices.find((c) => c.action === saving);
  return (
    <div ref={box} className="relative">
      <button
        ref={trigger}
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        aria-haspopup="true"
        disabled={saving !== null}
        className="inline-flex items-center gap-1.5 rounded-md border border-ops-line px-3 py-2 text-sm text-ops-text transition hover:border-ops-dim hover:bg-ops-raised disabled:opacity-40"
      >
        {pending ? "Saving…" : "Other decision"}
        <svg viewBox="0 0 12 12" aria-hidden className={`h-3 w-3 transition ${open ? "rotate-180" : ""}`}>
          <path d="M2.5 4.5 6 8l3.5-3.5" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </button>
      {open && (
        <ul className="absolute right-0 top-full z-10 mt-1 w-56 overflow-hidden rounded-md border border-ops-line bg-ops-raised py-1 shadow-lg shadow-black/50">
          {choices.map((c) => (
            <li key={c.action}>
              <button
                disabled={blocked(c)}
                onClick={() => {
                  setOpen(false);
                  onPick(c.action);
                }}
                className={`block w-full px-3 py-2 text-left text-sm transition hover:bg-white/5 disabled:opacity-40 ${c.action === "dismiss" ? "text-rose-200" : "text-ops-text"}`}
              >
                {c.text}
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

export function RetryButton({ reportId, text = "Retry the automatic check" }: { reportId: string; text?: string }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  async function retry() {
    setBusy(true);
    // Whatever the response (or a lost connection), the stored status is what to show next.
    await fetch(`/api/reports/${reportId}/analyze`, { method: "POST" }).catch(() => null);
    setBusy(false);
    router.refresh();
  }
  return (
    <button
      onClick={retry}
      disabled={busy}
      className="mt-3 rounded-md border border-ops-line px-3 py-1.5 text-sm text-ops-text hover:bg-ops-raised disabled:opacity-50"
    >
      {busy ? "Analyzing…" : text}
    </button>
  );
}
