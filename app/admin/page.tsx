// Author: HyeonMo Gu
// Created: 2026-10-27

import Link from "next/link";
import { mapIncidents, queue, staleAnalysis } from "@/lib/server/reports";
import { runtime } from "@/lib/server/runtime";
import type { Channel, Label } from "@/lib/tools/types";
import { ago, clock } from "@/app/_ui/format";
import { Kpi, LABEL_HEX, OpsLabel, UrgentTag } from "@/app/_ui/console";
import type { MapReport } from "./queue-map";
import { LiveRefresh } from "./live-refresh";
import { QueueMapLoader } from "./queue-map-loader";
import { LocateButton, QueueRow, SelectionProvider } from "./selection";

export const dynamic = "force-dynamic";
export const metadata = { title: "Staff queue · CiviFold" };

type Row = Awaited<ReturnType<typeof queue>>[number];
type Final = { label: Label; incident_id: string | null };

const DECIDED = new Set(["linked", "new_incident", "dismissed"]);

const ONE_CLICK: ReadonlySet<string> = new Set(["DUPLICATE", "LATE_REPORT", "ALREADY_RESOLVED", "NEW"]);

// Grouped by what staff do next. Possible emergencies (R0e) land in "To review" and sort first.
const TABS = [
  {
    id: "review",
    text: "Review",
    hint: "urgent, recurrence or unclear",
    match: (f: Final | null, s: string, urgent: boolean, stale: boolean) =>
      (urgent && !DECIDED.has(s)) || (s === "under_review" && !ONE_CLICK.has(f?.label ?? "")) || s === "unavailable" || s === "failed" || stale,
  },
  {
    id: "confirm",
    text: "Confirm",
    hint: "one click: link or open new",
    match: (f: Final | null, s: string, urgent: boolean, stale: boolean) => !urgent && !stale && s === "under_review" && ONE_CLICK.has(f?.label ?? ""),
  },
  { id: "waiting", text: "Waiting", hint: "asked the resident one question", match: (_: Final | null, s: string) => s === "needs_info" },
  { id: "done", text: "Decided", hint: "staff acted", match: (_: Final | null, s: string) => DECIDED.has(s) },
] as const;

// Within a tab: emergencies, then recurrences, then the rest, newest first.
const rank = (r: Row) => (r.report.urgent ? 0 : (r.analysis?.final as Final | undefined)?.label === "POSSIBLE_RECURRENCE" ? 1 : 2);

export default async function AdminQueue({ searchParams }: { searchParams: Promise<{ tab?: string }> }) {
  const rt = await runtime();
  const [rows, incidents, { tab: tabId }] = await Promise.all([queue(rt), mapIncidents(rt), searchParams]);
  const finalOf = (r: Row) => (r.analysis?.final as Final | undefined) ?? null;
  const counts = Object.fromEntries(
    TABS.map((t) => [t.id, rows.filter((r) => t.match(finalOf(r), r.report.status, r.report.urgent, staleAnalysis(r.report))).length]),
  );
  // Without a chosen tab, open the first one that has work in it.
  const tab = TABS.find((t) => t.id === tabId) ?? TABS.find((t) => t.id !== "done" && counts[t.id]! > 0) ?? TABS[0];
  const shown = rows
    .filter((r) => tab.match(finalOf(r), r.report.status, r.report.urgent, staleAnalysis(r.report)))
    .sort((a, b) => rank(a) - rank(b) || Date.parse(String(b.report.submitted_at)) - Date.parse(String(a.report.submitted_at)));
  const urgentOpen = rows.filter((r) => r.report.urgent && !DECIDED.has(r.report.status)).length;

  const today = new Date().toISOString().slice(0, 10);
  const analyzed = rows.filter((r) => r.analysis);
  const oneClick = analyzed.filter((r) => ["DUPLICATE", "LATE_REPORT", "ALREADY_RESOLVED"].includes(finalOf(r)?.label ?? "")).length;
  const waitingStaff = counts.review! + counts.confirm!;
  // Rows are numbered as listed; the map pin carries the same number.
  const numberOf = new Map(shown.map((r, i) => [r.report.id, i + 1]));
  const mapReports: MapReport[] = rows.map((r) => ({
    id: r.report.id,
    code: r.report.tracking_code,
    lat: r.report.lat,
    lng: r.report.lng,
    label: finalOf(r)?.label ?? null,
    urgent: r.report.urgent,
    incident_id: r.report.incident_id ?? finalOf(r)?.incident_id ?? null,
    n: numberOf.get(r.report.id) ?? null,
  }));

  return (
    <main className="mx-auto max-w-[1400px] px-4 pb-10 pt-4">
      <div className="grid grid-cols-2 gap-3 md:grid-cols-5">
        <Kpi label="Waiting for staff" value={waitingStaff} hint="suggestions to confirm" />
        <Kpi label="Urgent" value={urgentOpen} tone={urgentOpen ? "text-red-400" : "text-white"} hint="possible emergencies" />
        <Kpi
          label="One-click suggestions"
          value={analyzed.length ? `${Math.round((oneClick / analyzed.length) * 100)}%` : "n/a"}
          hint="duplicate, late or fixed"
        />
        <Kpi label="Waiting for residents" value={counts.waiting!} hint="one question each" />
        <Kpi label="Reports today" value={rows.filter((r) => new Date(r.report.submitted_at).toISOString().startsWith(today)).length} />
      </div>

      <SelectionProvider>
        <div className="mt-4 grid gap-4 lg:grid-cols-[minmax(0,1.3fr)_minmax(0,1fr)] xl:grid-cols-[minmax(0,1.15fr)_minmax(0,1fr)]">
          <section className="min-w-0 rounded-lg border border-ops-line bg-ops-panel">
            <nav className="flex flex-wrap items-center gap-1.5 border-b border-ops-line p-3">
              {TABS.map((t) => {
                const active = t.id === tab.id;
                return (
                  <Link
                    key={t.id}
                    href={`/admin?tab=${t.id}`}
                    title={t.hint}
                    className={`flex items-center gap-2 rounded-lg border px-3 py-2 text-sm font-semibold shadow-sm transition ${
                      active
                        ? "border-white bg-white text-slate-950"
                        : "border-zinc-600 bg-zinc-800/80 text-zinc-100 hover:border-zinc-400 hover:bg-zinc-700/80 hover:text-white"
                    }`}
                  >
                    {t.id === "review" && urgentOpen > 0 && (
                      <span className="h-2 w-2 animate-pulse rounded-full bg-red-500" aria-label={`${urgentOpen} urgent`} />
                    )}
                    {t.text}
                    <span className={`rounded-md px-1.5 py-0.5 font-mono text-xs ${active ? "bg-slate-950/10 text-slate-700" : "bg-black/40 text-zinc-300"}`}>
                      {counts[t.id]}
                    </span>
                  </Link>
                );
              })}
            </nav>
            {shown.length === 0 ? (
              <p className="py-16 text-center text-sm text-ops-dim">Nothing here.</p>
            ) : (
              <ul className="divide-y divide-ops-line">
                {shown.map((r) => {
                  const f = finalOf(r);
                  const triage = r.analysis?.triage as { category: string; damage_description: string | null } | null | undefined;
                  const intake = r.analysis?.intake as { category: string; problem: string | null; emergency_reason: string | null } | null | undefined;
                  const summary =
                    (r.report.urgent ? intake?.emergency_reason : null) ??
                    triage?.damage_description ??
                    intake?.problem ??
                    triage?.category ??
                    intake?.category ??
                    "";
                  const category = triage?.category ?? intake?.category;
                  const kind = category ? category.charAt(0).toUpperCase() + category.slice(1).replaceAll("_", " ") : null;
                  return (
                    <QueueRow key={r.report.id} id={r.report.id}>
                      <LocateButton id={r.report.id} n={numberOf.get(r.report.id)!} color={f ? LABEL_HEX[f.label] : "#6b7685"} urgent={r.report.urgent} />
                      <Link
                        href={`/admin/reports/${r.report.id}`}
                        className="group grid min-w-0 flex-1 grid-cols-[1fr_auto] items-center gap-x-3 gap-y-2 py-3 pl-3 pr-4 transition hover:bg-ops-raised sm:grid-cols-[130px_minmax(0,1fr)_auto_auto]"
                      >
                        <span className="min-w-0">
                          <span className="block font-mono text-[13px] text-white">{r.report.tracking_code}</span>
                          <span className="block font-mono text-[11px] text-ops-dim" title={ago(new Date(r.report.submitted_at).toISOString())}>
                            {clock(new Date(r.report.submitted_at).toISOString())}
                            {f?.incident_id ? ` · ${f.incident_id}` : ""}
                          </span>
                        </span>
                        <span className="flex min-w-0 flex-col items-end gap-1 sm:items-start" title={summary}>
                          <span className="flex items-center gap-1.5">
                            {r.report.urgent && <UrgentTag />}
                            {f ? (
                              <OpsLabel label={f.label} />
                            ) : (
                              <span className="text-[12px] text-ops-dim">{STATUS_TEXT[r.report.status] ?? r.report.status.replace("_", " ")}</span>
                            )}
                          </span>
                          {kind && <span className="max-w-full truncate text-[12px] text-ops-text">{kind}</span>}
                        </span>
                        <span className="flex gap-1">
                          {ATTACHED[r.report.channel as Channel].map((a) => (
                            <span key={a} className="rounded border border-ops-line px-1.5 py-px text-[11px] text-ops-dim">
                              {a}
                            </span>
                          ))}
                        </span>
                        <span
                          className={`justify-self-end whitespace-nowrap rounded-md border px-3 py-1 text-[13px] font-semibold transition group-hover:bg-white group-hover:text-slate-950 ${
                            r.report.urgent ? "border-red-500/70 text-red-200 group-hover:border-white" : "border-zinc-500 text-white group-hover:border-white"
                          }`}
                        >
                          {ACTION_TEXT[tab.id]} →
                        </span>
                      </Link>
                    </QueueRow>
                  );
                })}
              </ul>
            )}
          </section>

          <section id="queue-map" className="h-[420px] overflow-hidden rounded-lg border border-ops-line lg:sticky lg:top-16 lg:h-[calc(100vh-200px)]">
            <QueueMapLoader reports={mapReports} incidents={incidents} />
          </section>
        </div>
      </SelectionProvider>
      <p className="mt-3 flex flex-wrap gap-x-4 gap-y-1 text-[11px] text-ops-dim">
        <LiveRefresh />
        <span>numbered pin = the row with that number (click a number to find it) · ● other reports</span>
        <span>○ open incident · dashed ○ fixed</span>
        <span>line: report folded onto its incident</span>
        <span className="text-rose-300">- - recurrence chain</span>
      </p>
    </main>
  );
}

// Reports staff decided without an analysis (the demo's starting history), in plain words.
const STATUS_TEXT: Record<string, string> = { new_incident: "Opened an incident", linked: "Linked", dismissed: "Dismissed" };

// The row's button says what opening it is for in this tab.
const ACTION_TEXT: Record<(typeof TABS)[number]["id"], string> = { review: "Review", confirm: "Confirm", waiting: "View", done: "View" };

// What the resident sent; the full description stays one click away (and on hover).
const ATTACHED: Record<Channel, string[]> = {
  photo: ["Photo"],
  photo_text: ["Photo", "Text"],
  text: ["Text"],
  voice: ["Voice"],
  voice_photo: ["Photo", "Voice"],
};
