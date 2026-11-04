// Author: HyeonMo Gu
// Created: 2026-10-27

import Link from "next/link";
import { LinkPending } from "@/app/_ui/link-pending";
import { mapIncidents, queue, staleAnalysis } from "@/lib/server/reports";
import { runtime } from "@/lib/server/runtime";
import type { Channel, Label } from "@/lib/tools/types";
import { ago, clock } from "@/app/_ui/format";
import { LABEL_HEX, OpsLabel, UrgentTag } from "@/app/_ui/console";
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
    hint: "Possible emergencies, possible recurrences, unclear suggestions, and reports not checked yet.",
    // A report whose automatic check never started (it starts from the resident's tracking page) or is
    // still running is work too: without a row here it would be invisible until something analyzed it.
    match: (f: Final | null, s: string, urgent: boolean, stale: boolean) =>
      (urgent && !DECIDED.has(s)) || (s === "under_review" && !ONE_CLICK.has(f?.label ?? "")) || s === "unavailable" || s === "failed" || s === "received" || s === "analyzing" || stale,
  },
  {
    id: "confirm",
    text: "Confirm",
    hint: "Suggestions staff can accept in one click: link to an incident, or open a new one.",
    match: (f: Final | null, s: string, urgent: boolean, stale: boolean) => !urgent && !stale && s === "under_review" && ONE_CLICK.has(f?.label ?? ""),
  },
  { id: "waiting", text: "Waiting", hint: "Each waits on one answer from the resident.", match: (_: Final | null, s: string) => s === "needs_info" },
  { id: "done", text: "Decided", hint: "Staff already decided these.", match: (_: Final | null, s: string) => DECIDED.has(s) },
] as const;

// Within a tab: emergencies, then recurrences, then the rest, newest first.
const rank = (r: Row) => (r.report.urgent ? 0 : (r.analysis?.final as Final | undefined)?.label === "POSSIBLE_RECURRENCE" ? 1 : 2);

export default async function AdminQueue({ searchParams }: { searchParams: Promise<{ tab?: string }> }) {
  const rt = await runtime();
  const [received, incidents, { tab: tabId }] = await Promise.all([queue(rt), mapIncidents(rt), searchParams]);
  // Visitors send the same demo cases again and again: the queue lists the latest send of each.
  const listed = new Set<string>();
  const rows = received.filter((r) => {
    const tag = r.report.dataset_case_id;
    if (!tag?.startsWith("demo:")) return true;
    if (listed.has(tag)) return false;
    listed.add(tag);
    return true;
  });
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
  const reportsToday = rows.filter((r) => new Date(r.report.submitted_at).toISOString().startsWith(today)).length;
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
      {urgentOpen > 0 && (
        <Link
          href="/admin?tab=review"
          className="mb-4 flex items-center gap-3 rounded-lg border border-red-500/50 bg-red-500/10 px-4 py-2.5 text-sm text-red-100 transition hover:bg-red-500/15"
        >
          <span className="h-2 w-2 shrink-0 animate-pulse rounded-full bg-red-500" />
          <span>
            <span className="font-semibold">{urgentOpen === 1 ? "1 possible emergency" : `${urgentOpen} possible emergencies`} waiting.</span> First in Review;
            matching was skipped.
          </span>
        </Link>
      )}

      <SelectionProvider>
        <div className="grid gap-4 lg:grid-cols-[minmax(0,1.3fr)_minmax(0,1fr)] xl:grid-cols-[minmax(0,1.15fr)_minmax(0,1fr)]">
          <section className="min-w-0 rounded-lg border border-ops-line bg-ops-panel">
            <nav className="flex items-center gap-1 overflow-x-auto border-b border-ops-line px-2 [scrollbar-width:none]">
              {TABS.map((t) => {
                const active = t.id === tab.id;
                return (
                  <Link
                    key={t.id}
                    href={`/admin?tab=${t.id}`}
                    title={t.hint}
                    aria-current={active ? "page" : undefined}
                    className={`relative flex shrink-0 items-center gap-2 px-3 py-3 text-sm transition ${active ? "font-semibold text-white" : "text-ops-dim hover:text-white"}`}
                  >
                    {t.id === "review" && urgentOpen > 0 && (
                      <span className="h-2 w-2 animate-pulse rounded-full bg-red-500" aria-label={`${urgentOpen} urgent`} />
                    )}
                    {t.text}
                    <span className={`rounded px-1.5 text-xs tabular-nums ${active ? "bg-white/15 text-white" : "bg-ops-raised text-ops-dim"}`}>{counts[t.id]}</span>
                    <LinkPending />
                    {active && <span className="absolute inset-x-2 -bottom-px h-0.5 rounded-full bg-white" />}
                  </Link>
                );
              })}
            </nav>
            <p className="border-b border-ops-line px-4 py-2 text-xs text-ops-dim">{tab.hint}</p>
            {shown.length === 0 ? (
              <p className="py-16 text-center text-sm text-ops-dim">Nothing here.</p>
            ) : (
              <ul className="divide-y divide-ops-line">
                {shown.map((r) => {
                  const f = finalOf(r);
                  const triage = r.analysis?.triage as { category: string; damage_description: string | null } | null | undefined;
                  const intake = r.analysis?.intake as { category: string; problem: string | null; emergency_reason: string | null } | null | undefined;
                  const detail = (r.report.urgent ? intake?.emergency_reason : null) ?? triage?.damage_description ?? intake?.problem ?? null;
                  const category = triage?.category ?? intake?.category;
                  const kind = category ? category.charAt(0).toUpperCase() + category.slice(1).replaceAll("_", " ") : null;
                  const at = new Date(r.report.submitted_at).toISOString();
                  return (
                    <QueueRow key={r.report.id} id={r.report.id}>
                      <LocateButton id={r.report.id} n={numberOf.get(r.report.id)!} color={f ? LABEL_HEX[f.label] : "#8590a0"} urgent={r.report.urgent} />
                      <Link href={`/admin/reports/${r.report.id}`} className="group flex min-w-0 flex-1 items-center gap-3 py-2.5 pl-3 pr-4 transition hover:bg-ops-raised">
                        <Thumb photo={r.photo} channel={r.report.channel as Channel} />
                        <span className="min-w-0 flex-1">
                          <span className="flex flex-wrap items-center gap-1.5">
                            {r.report.urgent && <UrgentTag />}
                            {f ? (
                              <OpsLabel label={f.label} />
                            ) : (
                              <span className="text-xs text-ops-dim">{STATUS_TEXT[r.report.status] ?? r.report.status.replace("_", " ")}</span>
                            )}
                            {kind && <span className="text-[13px] font-medium text-white">{kind}</span>}
                          </span>
                          {detail && (
                            <span className="mt-1 block truncate text-[13px] text-ops-text" title={detail}>
                              {detail.charAt(0).toUpperCase() + detail.slice(1)}
                            </span>
                          )}
                          <span className="mt-0.5 block truncate text-xs text-ops-dim">
                            <span className="font-mono">{r.report.tracking_code}</span>
                            {" · "}
                            <span title={ago(at)}>{clock(at)}</span>
                            {` · ${ATTACHED[r.report.channel as Channel].join(" + ")}`}
                          </span>
                        </span>
                        <span className="flex shrink-0 items-center gap-1.5 text-sm text-ops-dim transition group-hover:text-white">
                          <LinkPending />
                          <span className="hidden sm:inline">{ACTION_TEXT[tab.id]} </span>›
                        </span>
                      </Link>
                    </QueueRow>
                  );
                })}
              </ul>
            )}
          </section>

          <section id="queue-map" className="relative h-[420px] overflow-hidden rounded-lg border border-ops-line lg:sticky lg:top-16 lg:h-[calc(100vh-140px)]">
            <QueueMapLoader reports={mapReports} incidents={incidents} />
            <MapLegend />
          </section>
        </div>
      </SelectionProvider>
      <p className="mt-3 flex flex-wrap gap-x-4 gap-y-1 text-xs text-ops-dim">
        <LiveRefresh />
        <span>{reportsToday} reports today</span>
        <span>A row&apos;s number is its pin on the map. Click the number to find it.</span>
      </p>
    </main>
  );
}

// A photo report's first photo; text and voice reports say what they are instead.
function Thumb({ photo, channel }: { photo: { id: string; is_synthetic: boolean } | null; channel: Channel }) {
  if (!photo) {
    return (
      <span className="flex h-12 w-16 shrink-0 items-center justify-center rounded-md border border-dashed border-ops-line text-[11px] text-ops-dim">
        {channel.startsWith("voice") ? "Voice" : "Text"}
      </span>
    );
  }
  return (
    <span className="relative h-12 w-16 shrink-0 overflow-hidden rounded-md bg-black">
      {/* eslint-disable-next-line @next/next/no-img-element -- resized by our image route */}
      <img src={`/api/images/${photo.id}?w=240`} alt="" loading="lazy" className="h-full w-full object-cover" />
      {photo.is_synthetic && (
        <span className="absolute inset-x-0 bottom-0 bg-black/75 text-center text-[9px] font-semibold leading-[14px] tracking-wide text-white">SYNTHETIC</span>
      )}
    </span>
  );
}

// Drawn over the map so the marks are explained where they are read.
function MapLegend() {
  const dot = (hex: string) => <span className="h-2.5 w-2.5 shrink-0 rounded-full" style={{ backgroundColor: hex }} />;
  return (
    <div className="pointer-events-none absolute bottom-2 left-2 z-[1000] space-y-1 rounded-md border border-ops-line bg-ops-bg/90 px-3 py-2 text-[11px] text-ops-text backdrop-blur">
      <p className="flex items-center gap-2">{dot(LABEL_HEX.DUPLICATE)}Folds onto an incident</p>
      <p className="flex items-center gap-2">{dot(LABEL_HEX.POSSIBLE_RECURRENCE)}Possible recurrence</p>
      <p className="flex items-center gap-2">{dot(LABEL_HEX.NEW)}New problem</p>
      <p className="flex items-center gap-2">{dot(LABEL_HEX.HUMAN_REVIEW)}Needs a person</p>
      <p className="flex items-center gap-2">
        <span className="h-2.5 w-2.5 shrink-0 rounded-full border-[1.5px] border-slate-200" />
        Open incident
        <span className="ml-1 h-2.5 w-2.5 shrink-0 rounded-full border-[1.5px] border-dashed border-emerald-400" />
        fixed
      </p>
      <p className="flex items-center gap-2">
        <span className="w-2.5 shrink-0 border-t-[1.5px] border-dashed border-rose-400" />
        Recurrence chain
      </p>
    </div>
  );
}

// Reports without an analysis, in plain words: not checked yet, or decided before any check (the demo's starting history).
const STATUS_TEXT: Record<string, string> = { received: "Not checked yet", analyzing: "Checking…", new_incident: "Opened an incident", linked: "Linked", dismissed: "Dismissed" };

// The row says what opening it is for in this tab.
const ACTION_TEXT: Record<(typeof TABS)[number]["id"], string> = { review: "Review", confirm: "Confirm", waiting: "View", done: "View" };

// What the resident sent.
const ATTACHED: Record<Channel, string[]> = {
  photo: ["Photo"],
  photo_text: ["Photo", "Text"],
  text: ["Text"],
  voice: ["Voice"],
  voice_photo: ["Photo", "Voice"],
};
