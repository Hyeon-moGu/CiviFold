// Author: HyeonMo Gu
// Created: 2026-10-27

import Link from "next/link";
import { notFound } from "next/navigation";
import { incidentDetail, incidentTitles } from "@/lib/server/reports";
import { runtime } from "@/lib/server/runtime";
import { when } from "@/app/_ui/format";
import { RealPhotoBadge, SyntheticBadge } from "@/app/_ui/labels";
import { isRealPhoto } from "@/app/_ui/photo";
import { categoryText, Fact, Panel, statusWord } from "@/app/_ui/console";
import { QueueMapLoader } from "../../queue-map-loader";
import { RepairButton } from "./repair-button";

export const dynamic = "force-dynamic";
export const metadata = { title: "Incident · CiviFold" };

const EVENT_DOT: Record<string, string> = {
  created: "bg-zinc-300",
  report_linked: "bg-sky-400",
  status_changed: "bg-amber-400",
  repair_recorded: "bg-emerald-400",
  recurrence_created: "bg-rose-400",
  note: "bg-ops-dim",
};

const named = (title: string | undefined, fallback: string) => (title ? title.charAt(0).toUpperCase() + title.slice(1) : fallback);

export default async function IncidentDetail({ params }: { params: Promise<{ id: string }> }) {
  const rt = await runtime();
  const detail = await incidentDetail(rt, (await params).id);
  if (!detail) notFound();
  const { incident, reports, photos, recurrences } = detail;
  // Older event summaries name an incident by id ("Opened as a recurrence of inc_..."): staff read its name, here and
  // in the recurrence links.
  const linked = [incident.recurrence_of, ...recurrences.map((r) => r.id)].filter((id): id is string => Boolean(id));
  const ids = [...new Set([...linked, ...detail.events.flatMap((e) => e.summary?.match(/\binc_[a-z0-9_]+/g) ?? [])])];
  const titles = await incidentTitles(rt, ids);
  // Stored summaries keep the words the agent's tools read; staff read merged for linked, and a cleanup for trash.
  const cleanup = detail.incident.category === "trash";
  const events = detail.events.map((e) => ({
    ...e,
    summary:
      e.summary
        ?.replace(/\binc_[a-z0-9_]+/g, (id) => (titles[id] ? `the ${titles[id]}` : "an earlier incident"))
        .replace(/^(Report \S+) linked$/, "$1 merged")
        .replace(/^Repair recorded by staff$/, cleanup ? "Cleanup recorded by staff" : "Repair recorded by staff") ?? e.summary,
  }));
  const open = incident.status === "open" || incident.status === "in_progress";
  const mapReports = reports.map((r) => ({ id: r.id, code: r.tracking_code, lat: r.lat, lng: r.lng, label: null, urgent: r.urgent, incident_id: incident.id, n: null }));

  return (
    <main className="mx-auto max-w-[1400px] px-4 py-5">
      <div className="flex flex-wrap items-center gap-3 text-[13px]">
        <Link href="/admin" className="text-ops-dim hover:text-white">
          ← Queue
        </Link>
        <span className="text-ops-line">/</span>
        <span className="text-ops-dim">Incident</span>
      </div>

      <header className="mt-3 flex flex-wrap items-center gap-3">
        <h1 className="text-xl font-semibold text-white">{named(incident.title, "Incident")}</h1>
        <span
          className={`inline-flex items-center gap-1.5 rounded-md px-2 py-0.5 text-[11px] font-medium ring-1 ring-inset ${
            open ? "bg-amber-500/10 text-amber-300 ring-amber-500/40" : "bg-emerald-500/10 text-emerald-300 ring-emerald-500/40"
          }`}
        >
          <span className={`h-1.5 w-1.5 rounded-full ${open ? "bg-amber-400" : "bg-emerald-400"}`} />
          {open ? "Open" : statusWord(incident.status, incident.category).replace(/^./, (c) => c.toUpperCase())}
        </span>
        {open && (
          <div className="ml-auto">
            <RepairButton incidentId={incident.id} cleanup={incident.category === "trash"} />
          </div>
        )}
      </header>

      <div className="mt-5 grid gap-4 lg:grid-cols-[minmax(0,1fr)_360px]">
        <div className="space-y-4">
          <Panel title="Reports on this incident" aside={`${reports.length} report${reports.length === 1 ? "" : "s"}`}>
            {reports.length === 0 ? (
              <p className="text-[13px] text-ops-dim">No reports on it yet.</p>
            ) : (
              <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 xl:grid-cols-4">
                {reports.map((r) => {
                  const photo = photos.find((p) => p.report_id === r.id);
                  return (
                    <Link key={r.id} href={`/admin/reports/${r.id}`} className="group overflow-hidden rounded-md border border-ops-line bg-ops-raised hover:border-zinc-500">
                      <div className="relative aspect-[3/2] bg-black">
                        {photo ? (
                          // eslint-disable-next-line @next/next/no-img-element -- resized by our image route
                          <img src={`/api/images/${photo.id}?w=480`} alt={r.tracking_code} className="h-full w-full object-cover opacity-90 group-hover:opacity-100" />
                        ) : (
                          <span className="flex h-full items-center justify-center font-mono text-[11px] text-ops-dim">{r.channel.toUpperCase()}</span>
                        )}
                        {(photo?.is_synthetic || isRealPhoto(photo)) && (
                          <span className="absolute left-1.5 top-1.5">{photo?.is_synthetic ? <SyntheticBadge /> : <RealPhotoBadge />}</span>
                        )}
                      </div>
                      <div className="flex flex-wrap items-baseline justify-between gap-x-2 px-2 py-1.5">
                        <span className="whitespace-nowrap font-mono text-[11px] text-ops-text">{r.tracking_code}</span>
                        <span className="whitespace-nowrap text-[11px] text-ops-dim">seen {when(r.observed_at)}</span>
                      </div>
                    </Link>
                  );
                })}
              </div>
            )}
          </Panel>

          <Panel title="Location" aside={<span className="font-mono">{`${incident.lat.toFixed(5)}, ${incident.lng.toFixed(5)}`}</span>}>
            <div className="-m-4 h-[320px] overflow-hidden rounded-b-lg">
              <QueueMapLoader reports={mapReports} incidents={[incident, ...recurrences]} />
            </div>
          </Panel>
        </div>

        <div className="space-y-4">
          <Panel title="Incident">
            <Fact k="Category" v={categoryText(incident.category)} />
            <Fact k="Opened" v={when(incident.created_at)} />
            <Fact k={incident.category === "trash" ? "Cleanup recorded" : "Repair recorded"} v={incident.resolved_at ? when(incident.resolved_at) : "Not yet"} />
            {incident.recurrence_of && (
              <Fact
                k="Recurrence of"
                v={
                  <Link href={`/admin/incidents/${incident.recurrence_of}`} title={incident.recurrence_of} className="text-rose-300 hover:underline">
                    {named(titles[incident.recurrence_of], "The earlier incident")}
                  </Link>
                }
              />
            )}
            {recurrences.length > 0 && (
              <Fact
                k="Came back as"
                v={
                  <span className="flex flex-col items-end gap-0.5">
                    {recurrences.map((r) => (
                      <Link key={r.id} href={`/admin/incidents/${r.id}`} title={r.id} className="text-rose-300 hover:underline">
                        {named(titles[r.id], "A later incident")}
                      </Link>
                    ))}
                  </span>
                }
              />
            )}
          </Panel>

          <Panel title="Timeline">
            <ol className="relative space-y-4 border-l border-ops-line pl-4">
              {events.map((e) => (
                <li key={e.id} className="relative">
                  <span className={`absolute -left-[21px] top-1.5 h-2 w-2 rounded-full ring-2 ring-ops-panel ${EVENT_DOT[e.type] ?? "bg-ops-dim"}`} />
                  <p className="text-[13px] text-ops-text">{e.summary}</p>
                  <p className="mt-0.5 font-mono text-[11px] text-ops-dim">
                    {when(e.created_at)} · {e.actor}
                  </p>
                </li>
              ))}
            </ol>
          </Panel>
        </div>
      </div>
    </main>
  );
}
