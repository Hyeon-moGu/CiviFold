// Author: HyeonMo Gu
// Created: 2026-10-27

"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import type { Label, RequestItem } from "@/lib/tools/types";
import { Spinner, useVerify } from "./verify";

type Action = "link" | "new_incident" | "recurrence" | "request_info" | "dismiss";

const SUGGESTED: Partial<Record<Label, Action>> = {
  DUPLICATE: "link",
  LATE_REPORT: "link",
  ALREADY_RESOLVED: "link",
  NEW: "new_incident",
  POSSIBLE_RECURRENCE: "recurrence",
};

export function Actions({
  reportId,
  analysisId,
  final,
  focusId,
  askFor,
  decided,
  stale,
  verify,
  verifyLimit,
}: {
  reportId: string;
  analysisId: number; // the analysis this screen shows; the server refuses a choice made on an older one
  final: { label: Label } | null;
  focusId: string | null;
  askFor: RequestItem;
  decided: boolean;
  stale: boolean; // an incident the suggestion relied on changed since: no one-click suggestion
  verify: { analysisId: number; running: boolean; again: boolean } | null; // the suggestion can be checked by the agent
  verifyLimit: number | null; // the suggestion could be checked, but this many runs is the most allowed
}) {
  const router = useRouter();
  const checking = useVerify();
  const [saving, setBusy] = useState<Action | null>(null);
  const [error, setError] = useState<string | null>(null);
  const suggested = final && !stale ? SUGGESTED[final.label] : undefined;
  const verifying = checking?.state.phase === "running";
  const busy = saving ?? (checking?.busy ? "verify" : null);

  async function act(action: Action) {
    setBusy(action);
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
      const body = (await res.json().catch(() => ({}))) as { error?: string; code?: string };
      if (!res.ok) {
        setError(body.error ?? "Could not save that.");
        // Refused because the screen was out of date: show the latest so the next choice is made on it.
        if (body.code === "stale") router.refresh();
        return;
      }
      router.refresh();
    } catch {
      // The request may or may not have reached the server: show what is stored now.
      setError("Could not confirm that it was saved (connection problem). The page was reloaded to show what is stored.");
      router.refresh();
    } finally {
      setBusy(null);
    }
  }

  if (decided) return <p className="rounded-md border border-emerald-500/30 bg-emerald-500/10 px-4 py-2 text-sm text-emerald-200">Decided by staff.</p>;

  const buttons: Array<{ action: Action; text: string; needs?: boolean }> = [
    {
      action: "link",
      text: focusId ? `Link to ${focusId}` : "Link",
      needs: true,
    },
    { action: "new_incident", text: "Open a new incident" },
    {
      action: "recurrence",
      text: focusId ? `Recurrence of ${focusId}` : "Recurrence",
      needs: true,
    },
    {
      action: "request_info",
      text: askFor === "photo" ? "Ask for a photo" : "Ask the resident",
    },
    { action: "dismiss", text: "Dismiss" },
  ];
  // The suggestion comes first and largest; the rest stay one click away. Verifying is a separate request.
  const ordered = [...buttons.filter((b) => b.action === suggested), ...buttons.filter((b) => b.action !== suggested)];
  return (
    <div className="flex shrink-0 flex-col gap-1.5 xl:items-end">
      <div className="flex flex-wrap items-center gap-1.5 xl:justify-end">
        {ordered.map((b) => (
          <button
            key={b.action}
            disabled={busy !== null || (b.needs && !focusId)}
            onClick={() => act(b.action)}
            className={`rounded-md text-sm transition disabled:opacity-35 ${
              suggested === b.action
                ? "bg-white px-4 py-2 font-semibold text-slate-950 hover:bg-zinc-200"
                : "border border-ops-line px-3 py-1.5 text-ops-text hover:border-ops-dim hover:bg-ops-raised"
            }`}
          >
            {busy === b.action ? "Saving…" : b.text}
          </button>
        ))}
        {verify && checking && (
          <button
            disabled={busy !== null || verify.running}
            onClick={() => checking.start(verify.analysisId)}
            title="Muse Spark looks for evidence against this suggestion with the pipeline's tools. It can only make the suggestion more cautious."
            className="inline-flex items-center gap-2 rounded-md border border-sky-500/50 bg-sky-500/10 px-3 py-1.5 text-sm text-sky-200 transition hover:border-sky-400 hover:bg-sky-500/20 disabled:opacity-35"
          >
            {(verifying || verify.running) && <Spinner className="h-3 w-3" />}
            {verifying || verify.running ? "Verifying…" : verify.again ? "Verify again" : "Verify with the agent"}
          </button>
        )}
        {!verify && verifyLimit !== null && (
          <button disabled title="Each report can be verified at most this many times." className="rounded-md border border-ops-line px-3 py-1.5 text-sm text-ops-dim opacity-60">
            Verified {verifyLimit} times (the limit)
          </button>
        )}
      </div>
      {error ? (
        <p className="text-sm text-rose-300">{error}</p>
      ) : (
        <p className="text-[11px] text-ops-dim">
          {verifying ? "Decisions wait until the check finishes. " : suggested ? "The white button is the suggestion. " : stale ? "The suggestion is out of date. " : ""}
          Nothing is merged or closed until you choose.
        </p>
      )}
    </div>
  );
}

export function RetryButton({ reportId }: { reportId: string }) {
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
      {busy ? "Analyzing…" : "Retry the automatic check"}
    </button>
  );
}
