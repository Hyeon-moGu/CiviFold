// Author: HyeonMo Gu
// Created: 2026-10-27

"use client";

import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import type { ResidentView } from "@/lib/server/views";
import { SyntheticBadge } from "@/app/_ui/labels";
import { when } from "@/app/_ui/format";

const PHOTO_STEPS = ["Reading the photo", "Looking for reports nearby", "Comparing photos of the place", "Checking dates and repairs"];

function stepsFor(view: ResidentView | null): string[] {
  if (!view) return PHOTO_STEPS;
  const heard = view.has_audio ? ["Listening to your recording"] : [];
  const read = view.description || view.has_audio ? ["Reading your message"] : [];
  return view.photos.length > 0 ? [...heard, ...read, ...PHOTO_STEPS] : [...heard, ...read, "Looking for reports nearby"];
}

export function TrackView({ code }: { code: string }) {
  const [view, setView] = useState<ResidentView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [working, setWorking] = useState(false);
  const [step, setStep] = useState(0);
  const started = useRef(false);

  const load = useCallback(async () => {
    const res = await fetch(`/api/track/${code}`, { cache: "no-store" });
    const body = (await res.json()) as ResidentView & { error?: string };
    if (!res.ok) return setError(body.error ?? "Report not found.");
    setView(body);
    return body;
  }, [code]);

  const run = useCallback(
    async (request: () => Promise<Response>) => {
      setWorking(true);
      setStep(0);
      const timer = setInterval(() => setStep((s) => s + 1), 4000);
      try {
        const res = await request();
        const body = (await res.json()) as { error?: string };
        if (!res.ok || body.error) setError(body.error ?? "Something went wrong.");
      } finally {
        clearInterval(timer);
        setWorking(false);
        await load();
      }
    },
    [load],
  );

  useEffect(() => {
    void load().then((v) => {
      // A fresh report is analyzed as soon as its page opens.
      if (v && v.status === "received" && !started.current) {
        started.current = true;
        void run(() => fetch(`/api/reports/${v.report_id}/analyze`, { method: "POST" }));
      }
    });
  }, [load, run]);

  if (error && !view) return <p className="rounded-lg bg-rose-50 px-3 py-2 text-rose-800">{error}</p>;
  if (!view) return <p className="text-zinc-500">Loading…</p>;
  const steps = stepsFor(view);
  const current = Math.min(step, steps.length - 1);

  return (
    <div className="space-y-5">
      <header className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <p className="text-xs font-medium uppercase tracking-wider text-zinc-500">Tracking code</p>
          <h1 className="mt-0.5 font-mono text-2xl font-semibold tracking-wider sm:text-3xl">{view.tracking_code}</h1>
        </div>
        <p className="text-xs text-zinc-500">
          Seen {when(view.observed_at)} · sent {when(view.submitted_at)}
        </p>
      </header>

      <Stages status={working ? "analyzing" : view.status} />

      <section className={`rounded-2xl border p-5 ${view.urgent && !working ? "border-rose-300 bg-rose-50" : "border-zinc-200 bg-zinc-50/60"}`}>
        {working ? (
          <ol className="space-y-2.5 text-sm">
            {steps.map((s, i) => (
              <li key={s} className={`flex items-center gap-2.5 ${i < current ? "text-zinc-400" : i === current ? "font-medium text-zinc-900" : "text-zinc-400"}`}>
                <span className={`flex h-5 w-5 items-center justify-center rounded-full text-[10px] ${i < current ? "bg-zinc-900 text-white" : i === current ? "animate-pulse bg-zinc-900 text-white" : "bg-zinc-200"}`}>
                  {i < current ? "✓" : ""}
                </span>
                {s}
              </li>
            ))}
          </ol>
        ) : (
          <p className={`text-[17px] leading-relaxed ${view.urgent ? "font-medium text-rose-900" : "text-zinc-900"}`}>{view.status_text}</p>
        )}
        {error && <p className="mt-3 text-sm text-rose-700">{error}</p>}
      </section>

      {view.question && !working && <Answer view={view} onAnswer={(form) => run(() => fetch(`/api/reports/${view.report_id}/answer`, { method: "POST", body: form }))} />}

      {(view.description || view.has_audio) && (
        <section className="space-y-2 rounded-2xl border border-zinc-200 p-5 text-sm">
          <h2 className="text-xs font-medium uppercase tracking-wider text-zinc-500">Your message</h2>
          {view.description && <p>{view.description}</p>}
          {view.has_audio && (
            <>
              <audio controls src={`/api/reports/${view.report_id}/audio`} className="h-9 w-full" />
              <p className="text-zinc-600">{view.transcript ? `Transcript: “${view.transcript}”` : "Not transcribed yet."}</p>
            </>
          )}
        </section>
      )}

      {view.photos.length > 0 && (
        <section className="grid grid-cols-2 gap-2.5 sm:grid-cols-3">
          {view.photos.map((id) => (
            <div key={id} className="relative overflow-hidden rounded-xl border border-zinc-200">
              {/* eslint-disable-next-line @next/next/no-img-element -- resized by our image route */}
              <img src={`/api/images/${id}?w=480`} alt="Your photo" className="aspect-[3/2] w-full object-cover" />
              <span className="absolute left-1.5 top-1.5">
                <SyntheticBadge />
              </span>
            </div>
          ))}
        </section>
      )}

      <p className="text-sm">
        <Link href="/report" className="font-medium text-zinc-900 underline underline-offset-2">
          Report something else →
        </Link>
      </p>
    </div>
  );
}

const STAGES = ["Sent", "Checked", "With staff", "Decided"];
const STAGE_OF: Record<string, number> = { received: 1, analyzing: 1, needs_info: 1, under_review: 2, unavailable: 2, failed: 2, linked: 4, new_incident: 4, dismissed: 4 };

// Where the report is in its life; a question back to the resident holds it at the check.
function Stages({ status }: { status: string }) {
  const at = STAGE_OF[status] ?? 1;
  return (
    <ol className="flex items-center gap-1.5">
      {STAGES.map((name, i) => (
        <li key={name} className="flex flex-1 flex-col gap-1.5">
          <span className={`h-1.5 rounded-full ${i < at ? "bg-zinc-900" : i === at ? (status === "needs_info" ? "bg-violet-500" : "animate-pulse bg-zinc-400") : "bg-zinc-200"}`} />
          <span className={`text-[11px] ${i <= at ? "font-medium text-zinc-800" : "text-zinc-400"}`}>{i === at && status === "needs_info" ? "Your answer" : name}</span>
        </li>
      ))}
    </ol>
  );
}

function Answer({ view, onAnswer }: { view: ResidentView; onAnswer: (form: FormData) => void }) {
  const q = view.question!;
  const wantsTime = q.requested_items.includes("observed_time");
  const [time, setTime] = useState("");
  const [picked, setPicked] = useState<string | null>(null);

  function send(e: React.FormEvent) {
    e.preventDefault();
    const form = new FormData();
    if (wantsTime && time) form.set("observed_at", new Date(time).toISOString());
    if (!wantsTime && picked) form.set("sample_id", picked);
    onAnswer(form);
  }

  return (
    <form onSubmit={send} className="space-y-4 rounded-2xl border border-violet-300 bg-violet-50 p-5">
      <p className="font-medium">{q.question}</p>
      {wantsTime ? (
        <input type="datetime-local" value={time} onChange={(e) => setTime(e.target.value)} className="w-full rounded-lg border border-zinc-300 bg-white px-3 py-2.5 text-[15px]" />
      ) : (
        <>
          <p className="text-xs text-zinc-600">Demo: pick the photo you would take now.</p>
          <div className="grid grid-cols-3 gap-2 sm:grid-cols-4">
            {view.suggested_samples.map((s) => (
              <button
                key={s.id}
                type="button"
                onClick={() => setPicked(s.id)}
                className={`overflow-hidden rounded-md border ${picked === s.id ? "border-violet-600 ring-2 ring-violet-600" : "border-zinc-200"}`}
              >
                {/* eslint-disable-next-line @next/next/no-img-element -- resized by our image route */}
                <img src={`/api/samples/${s.id}/image?w=240`} alt={s.title} className="aspect-[3/2] w-full object-cover" />
              </button>
            ))}
          </div>
        </>
      )}
      <button disabled={wantsTime ? !time : !picked} className="w-full rounded-lg bg-violet-700 px-4 py-3 text-sm font-semibold text-white disabled:opacity-50 sm:w-auto sm:px-8">
        Send answer
      </button>
    </form>
  );
}
