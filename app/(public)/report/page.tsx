// Author: HyeonMo Gu
// Created: 2026-10-27

import { messageSamples } from "@/lib/dataset/messages";
import { DEMO_TIME_ZONE } from "@/lib/dataset/place";
import { REAL_PAIRS } from "@/lib/dataset/real";
import { ASSET_FILE, samples } from "@/lib/dataset/static";
import { seedIncidentId } from "@/lib/demo/seed";
import { mapIncidents } from "@/lib/server/reports";
import { runtime } from "@/lib/server/runtime";
import { ReportForm, type RealSampleView } from "./report-form";

const DAY = new Intl.DateTimeFormat("en-US", { month: "long", day: "numeric", timeZone: DEMO_TIME_ZONE });
const SF_TIME = new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit", timeZone: DEMO_TIME_ZONE });
const sentence = (t: string) => t.charAt(0).toUpperCase() + t.slice(1);
// The later request of each real San Francisco pair, offered first; the earlier one is the incident on file.
const REAL_SAMPLES: RealSampleView[] = REAL_PAIRS.map((p) => ({
  id: p.later.id,
  title: sentence(p.later_title ?? p.title),
  detail: `311 request ${p.later.case}, ${DAY.format(new Date(p.later.observed_at))}`,
  category: p.category,
  lat: p.later.lat,
  lng: p.later.lng,
  observed_at: p.later.observed_at,
  reported: `${SF_TIME.format(new Date(p.later.observed_at))} San Francisco time`,
}));

export const metadata = { title: "Report a problem · CiviFold" };
export const dynamic = "force-dynamic";

export default async function ReportPage({ searchParams }: { searchParams: Promise<{ source?: string }> }) {
  // The demo's "try your own photo live" link opens with the upload chosen.
  const { source } = await searchParams;
  // The incidents on file, so a visitor can put the pin on one: a report is compared only with incidents near it.
  // Named as the demo names them ("hydrant by the BAKERY"), from the dataset asset a seeded incident stands for.
  const assets = new Map(ASSET_FILE.assets.map((a) => [seedIncidentId(a.id), a]));
  const places = (await mapIncidents(await runtime())).map((i) => {
    const a = assets.get(i.id);
    return { id: i.id, lat: i.lat, lng: i.lng, title: a ? `${a.object_short} by the ${a.sign_texts[0]}` : i.title, open: i.status === "open" || i.status === "in_progress" };
  });
  return (
    <main className="mx-auto max-w-3xl px-4 py-8">
      <h1 className="text-2xl font-semibold tracking-tight">Report a problem</h1>
      <p className="mt-1.5 text-sm text-zinc-600">A broken fixture or a problem at a place: a hydrant, a street light, a pothole, dumped trash. Three steps, under a minute.</p>
      <p className="mt-3 rounded-lg border border-amber-200 bg-amber-50 px-3.5 py-2.5 text-xs text-amber-900">
        This is a hackathon demo. Reports are not sent to any city or 311 service, and anything you send, photos and recordings included, can be seen by
        anyone who opens the staff console. Leave out faces, license plates and personal details.
      </p>
      <ReportForm samples={samples()} realSamples={REAL_SAMPLES} messages={messageSamples()} places={places} initialSource={source === "upload" ? "upload" : "sample"} />
    </main>
  );
}
