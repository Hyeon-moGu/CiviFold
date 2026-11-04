// Author: HyeonMo Gu
// Created: 2026-10-27

"use client";

import dynamic from "next/dynamic";
import { useRouter } from "next/navigation";
import { useMemo, useRef, useState, type ReactNode } from "react";
import type { MessageSample } from "@/lib/dataset/messages";
import { haversineM } from "@/lib/geo";
import { MAX_DESCRIPTION_CHARS } from "@/lib/limits";
import type { Sample } from "@/lib/dataset/static";

/** A real San Francisco 311 photo offered as a sample: sent at its own place and time (lib/dataset/real.ts). */
export type RealSampleView = { id: string; title: string; detail: string; category: Category; lat: number; lng: number; observed_at: string; reported: string };
type Picked = { id: string; title: string; lat: number; lng: number; category: Category; observed_at?: string; reported?: string };
import type { Category } from "@/lib/tools/types";
import { RealPhotoBadge, SyntheticBadge } from "@/app/_ui/labels";
import type { MapPlace } from "@/app/_ui/pin-map";
import { pauseFrom, usePaused } from "@/app/_ui/pause";
import { EXIF_SLICE, isHeic, shrinkForUpload } from "@/app/_ui/shrink";
import { Recorder } from "./recorder";

// Leaflet needs the browser's window.
const PinMap = dynamic(() => import("@/app/_ui/pin-map"), {
  ssr: false,
  loading: () => <div className="flex h-full items-center justify-center text-xs text-zinc-500">Loading map…</div>,
});

const CATEGORIES: Array<{ id: Category; text: string }> = [
  { id: "fire_hydrant", text: "Fire hydrant" },
  { id: "streetlight", text: "Street light" },
  { id: "traffic_sign", text: "Traffic sign" },
  { id: "bench", text: "Bench" },
  { id: "road_damage", text: "Road or sidewalk damage" },
  { id: "trash", text: "Trash or illegal dumping" },
  { id: "graffiti", text: "Graffiti" },
  { id: "other", text: "Something else" },
];

const STEPS = ["Photo", "Place", "Details"] as const;

type When = "now" | "earlier" | "custom";

// datetime-local wants the viewer's local time, without a zone.
function localInput(iso: string): string {
  const d = new Date(iso);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export function ReportForm({
  samples,
  realSamples = [],
  messages,
  places,
  initialSource = "sample",
}: {
  samples: Sample[];
  realSamples?: RealSampleView[];
  messages: MessageSample[];
  places: MapPlace[];
  initialSource?: "sample" | "upload";
}) {
  const router = useRouter();
  const [step, setStep] = useState(0);
  const lastStepAt = useRef(0); // when the form moved to a new step
  const [source, setSource] = useState<"sample" | "upload" | "none">(initialSource);
  const [filter, setFilter] = useState<Category | "all">("all");
  // Real 311 photos first; the generated ones cover the kinds the real set has none of.
  const [sampleSet, setSampleSet] = useState<"real" | "generated">(realSamples.length > 0 ? "real" : "generated");
  const [picked, setPicked] = useState<Picked | null>(null);
  const [file, setFile] = useState<File | null>(null);
  const [preview, setPreview] = useState<string | null>(null);
  // What the chosen photo's EXIF supplied; edited fields stop counting as "from the photo".
  const [exif, setExif] = useState<{ lat: string; lng: string; time: string } | null>(null);
  const [lat, setLat] = useState("");
  const [lng, setLng] = useState("");
  const [when, setWhen] = useState<When>("now");
  const [custom, setCustom] = useState("");
  const [category, setCategory] = useState<Category | "">("");
  const [description, setDescription] = useState("");
  const [voiceSample, setVoiceSample] = useState<MessageSample | null>(null);
  const [recording, setRecording] = useState<Blob | null>(null);
  const [accessCode, setAccessCode] = useState("");
  const [danger, setDanger] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const shown = useMemo(() => (filter === "all" ? samples : samples.filter((s) => s.category === filter)), [samples, filter]);
  const present = useMemo(() => new Set(samples.map((s) => s.category)), [samples]);

  function pick(s: Picked) {
    setPicked(s);
    setLat(s.lat.toFixed(6));
    setLng(s.lng.toFixed(6));
    setCategory(s.category);
    // A real request keeps the time it was made; a generated sample is seen now.
    if (s.observed_at) {
      setWhen("custom");
      setCustom(localInput(s.observed_at));
    } else if (picked?.observed_at) {
      setWhen("now");
      setCustom("");
    }
  }

  // A sample message stands in for what a resident would type or say on the spot, without a photo.
  function pickMessage(m: MessageSample) {
    setPicked(null);
    setLat(m.lat.toFixed(6));
    setLng(m.lng.toFixed(6));
    setCategory(m.category_hint ?? "");
    if (m.kind === "voice") {
      setVoiceSample(m);
      setRecording(null);
      setDescription("");
    } else {
      setVoiceSample(null);
      setDescription(m.text);
    }
  }

  function record(wav: Blob | null) {
    setRecording(wav);
    if (wav) setVoiceSample(null);
  }

  async function choosePhoto(f: File | null) {
    setFile(null);
    setExif(null);
    setError(null);
    if (preview) URL.revokeObjectURL(preview);
    setPreview(null);
    if (!f) return;
    if (isHeic(f)) return setError("HEIC photos cannot be analyzed yet. Set the iPhone camera to Most Compatible, or export the photo as JPEG.");
    setFile(f);
    setPreview(URL.createObjectURL(f));
    const form = new FormData();
    form.set("photo", new File([f.slice(0, EXIF_SLICE)], f.name, { type: f.type }));
    form.set("tz_offset", String(new Date().getTimezoneOffset()));
    const res = await fetch("/api/photo-meta", { method: "POST", body: form }).catch(() => null);
    const meta = res?.ok ? ((await res.json()) as { lat: number | null; lng: number | null; taken_at: string | null }) : null;
    const found = { lat: meta?.lat?.toFixed(6) ?? "", lng: meta?.lng?.toFixed(6) ?? "", time: meta?.taken_at ? localInput(meta.taken_at) : "" };
    if (found.lat) {
      setLat(found.lat);
      setLng(found.lng);
    }
    if (found.time) {
      setWhen("custom");
      setCustom(found.time);
    }
    setExif(found);
  }

  function locate() {
    navigator.geolocation?.getCurrentPosition(
      (p) => {
        setLat(p.coords.latitude.toFixed(6));
        setLng(p.coords.longitude.toFixed(6));
      },
      () => setError("Your browser did not share a location. Tap the map instead."),
    );
  }

  // Each step checks only what it asks for, so the resident learns what is missing where they can fix it.
  function blocker(at: number): string | null {
    if (at === 0) {
      if (source === "sample" && !picked) return "Pick a sample photo, or choose No photo.";
      if (source === "upload" && !file) return "Choose a photo to upload.";
    }
    if (at === 1 && (!lat || !lng)) return "Set where the problem is: tap the map.";
    if (at === 2) {
      if (source === "none" && !voiceSample && !recording && !description.trim()) return "Without a photo, tell us about it: type a message or record one.";
    }
    return null;
  }

  function next() {
    const why = blocker(step);
    setError(why);
    if (!why) {
      lastStepAt.current = Date.now();
      setStep((s) => Math.min(s + 1, STEPS.length - 1));
    }
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (step < STEPS.length - 1) return next();
    // "Send report" sits where "Next" was: a double click on Next must not send before the last step is read.
    if (Date.now() - lastStepAt.current < 800) return;
    for (let at = 0; at < STEPS.length; at++) {
      const why = blocker(at);
      if (why) {
        setStep(at);
        return setError(why);
      }
    }
    setError(null);
    setBusy(true);
    try {
      const form = new FormData();
      if (source === "sample" && picked) form.set("sample_id", picked.id);
      else if (source === "upload" && file) form.set("photo", await shrinkForUpload(file));
      if (voiceSample) form.set("voice_sample_id", voiceSample.id);
      if (recording) form.set("voice", new File([recording], "voice.wav", { type: "audio/wav" }));
      if (needsCode) form.set("access_code", accessCode);
      form.set("tz_offset", String(new Date().getTimezoneOffset()));
      if (exif?.time && when === "custom" && custom === exif.time) form.set("observed_at_source", "exif");
      if (danger) form.set("danger", "yes");
      form.set("lat", lat);
      form.set("lng", lng);
      const observed = when === "now" ? new Date() : when === "earlier" ? new Date(Date.now() - 3 * 3_600_000) : custom ? new Date(custom) : null;
      if (observed) form.set("observed_at", observed.toISOString());
      if (category) form.set("category_hint", category);
      if (description) form.set("description", description);
      const res = await fetch("/api/reports", { method: "POST", body: form });
      pauseFrom(res, "report");
      const body = (await res.json()) as { tracking_code?: string; error?: string };
      if (!res.ok || !body.tracking_code) return setError(body.error ?? "The report could not be sent.");
      router.push(`/track/${body.tracking_code}`);
    } catch {
      // A dropped connection or a photo the browser could not re-encode: the button must come back.
      setError("The report could not be sent. Check your connection and try again.");
    } finally {
      setBusy(false);
    }
  }

  const needsCode = source === "upload" || recording !== null;
  const paused = usePaused("report");
  const chip = (active: boolean) =>
    `shrink-0 rounded-full px-3 py-1.5 text-sm transition ${active ? "bg-zinc-900 text-white" : "bg-zinc-100 text-zinc-700 hover:bg-zinc-200"}`;
  const input = "w-full rounded-lg border border-zinc-300 bg-white px-3 py-2.5 text-[15px] focus:border-zinc-900 focus:outline-none focus:ring-2 focus:ring-zinc-900/10";
  const thumb = picked ? `/api/samples/${picked.id}/image?w=240` : preview;
  const latN = lat && !Number.isNaN(Number(lat)) ? Number(lat) : null;
  const lngN = lng && !Number.isNaN(Number(lng)) ? Number(lng) : null;
  // The incident on file closest to the pin: a report is compared only with incidents close to it.
  const nearest =
    latN !== null && lngN !== null && places.length
      ? places.map((p) => ({ place: p, m: haversineM({ lat: latN, lng: lngN }, p) })).sort((a, b) => a.m - b.m)[0]!
      : null;

  return (
    <form onSubmit={submit} className="mt-6">
      <Progress step={step} onJump={(at) => at < step && (setError(null), setStep(at))} />

      <div className="mt-6">
        {step === 0 && (
          <Step title="What did you see?" hint="A photo lets the system tell this problem apart from others nearby.">
            <div className="grid grid-cols-3 gap-2">
              {(
                [
                  ["sample", "Sample photo", "Real 311 or generated"],
                  ["upload", "My photo", "Needs an access code"],
                  ["none", "No photo", "Text or voice"],
                ] as const
              ).map(([id, title, sub]) => (
                <button
                  key={id}
                  type="button"
                  onClick={() => (setSource(id), setError(null))}
                  className={`rounded-xl border px-3 py-3 text-left transition ${source === id ? "border-zinc-900 bg-zinc-50 ring-1 ring-zinc-900" : "border-zinc-200 hover:border-zinc-300"}`}
                >
                  <span className="block text-sm font-medium">{title}</span>
                  <span className="mt-0.5 block text-[11px] text-zinc-500">{sub}</span>
                </button>
              ))}
            </div>

            {source === "sample" && realSamples.length > 0 && (
              <div className="mt-5 inline-flex rounded-lg bg-zinc-100 p-1 text-sm" role="tablist">
                {(
                  [
                    ["real", "Real 311 photos (San Francisco)"],
                    ["generated", "Generated (Muse Image)"],
                  ] as const
                ).map(([id, text]) => (
                  <button
                    key={id}
                    type="button"
                    role="tab"
                    aria-selected={sampleSet === id}
                    onClick={() => setSampleSet(id)}
                    className={`rounded-md px-3 py-1.5 font-medium transition ${sampleSet === id ? "bg-white text-zinc-900 shadow-sm" : "text-zinc-600 hover:text-zinc-900"}`}
                  >
                    {text}
                  </button>
                ))}
              </div>
            )}

            {source === "sample" && sampleSet === "real" && realSamples.length > 0 && (
              <>
                <div className="mt-3 grid grid-cols-2 gap-2.5 sm:grid-cols-4">
                  {realSamples.map((s) => (
                    <button
                      key={s.id}
                      type="button"
                      onClick={() => (pick(s), setError(null))}
                      className={`group relative overflow-hidden rounded-xl border text-left transition ${picked?.id === s.id ? "border-zinc-900 ring-2 ring-zinc-900" : "border-zinc-200 hover:border-zinc-300"}`}
                    >
                      {/* eslint-disable-next-line @next/next/no-img-element -- resized by our image route */}
                      <img src={`/api/samples/${s.id}/image?w=240`} alt={s.title} loading="lazy" className="aspect-[4/3] w-full object-cover" />
                      <span className="absolute left-1.5 top-1.5">
                        <RealPhotoBadge />
                      </span>
                      {picked?.id === s.id && <span className="absolute right-1.5 top-1.5 rounded-full bg-zinc-900 px-1.5 text-xs font-bold text-white">✓</span>}
                      <span className="block px-2 py-1.5 text-xs leading-snug">
                        <span className="block font-medium text-zinc-800">{s.title}</span>
                        <span className="block text-zinc-500">{s.detail}</span>
                      </span>
                    </button>
                  ))}
                </div>
                <p className="mt-2 text-xs text-zinc-500">
                  Real requests residents sent to San Francisco 311 (DataSF public records), with people and license plates blurred. Each goes in at its own
                  place and time, next to the earlier request on file there.
                </p>
              </>
            )}

            {source === "sample" && sampleSet === "generated" && (
              <>
                <div className="-mx-4 mt-3 flex gap-1.5 overflow-x-auto px-4 pb-1 sm:mx-0 sm:flex-wrap sm:px-0">
                  <button type="button" className={chip(filter === "all")} onClick={() => setFilter("all")}>
                    All
                  </button>
                  {CATEGORIES.filter((c) => present.has(c.id)).map((c) => (
                    <button key={c.id} type="button" className={chip(filter === c.id)} onClick={() => setFilter(c.id)}>
                      {c.text}
                    </button>
                  ))}
                </div>
                <div className="mt-3 grid max-h-[52vh] grid-cols-2 gap-2.5 overflow-y-auto pr-0.5 sm:grid-cols-3 lg:grid-cols-4">
                  {shown.map((s) => (
                    <button
                      key={s.id}
                      type="button"
                      onClick={() => (pick(s), setError(null))}
                      className={`group relative overflow-hidden rounded-xl border text-left transition ${picked?.id === s.id ? "border-zinc-900 ring-2 ring-zinc-900" : "border-zinc-200 hover:border-zinc-300"}`}
                    >
                      {/* eslint-disable-next-line @next/next/no-img-element -- resized by our image route */}
                      <img src={`/api/samples/${s.id}/image?w=240`} alt={`${tileTitle(s.title).place}, ${tileTitle(s.title).view}`} loading="lazy" className="aspect-[3/2] w-full object-cover" />
                      <span className="absolute left-1.5 top-1.5">
                        <SyntheticBadge />
                      </span>
                      {picked?.id === s.id && <span className="absolute right-1.5 top-1.5 rounded-full bg-zinc-900 px-1.5 text-xs font-bold text-white">✓</span>}
                      <span className="block px-2 py-1.5 text-xs leading-snug">
                        <span className="block text-zinc-500">{tileTitle(s.title).place}</span>
                        <span className="block font-medium text-zinc-800 first-letter:uppercase">
                          {tileTitle(s.title).state}, {tileTitle(s.title).view}
                        </span>
                      </span>
                    </button>
                  ))}
                </div>
                <p className="mt-2 text-xs text-zinc-500">
                  Generated with Muse Image for the evaluation, each marked SYNTHETIC: look-alikes a few doors apart and fixtures before and after a repair,
                  which real records rarely contain.
                </p>
              </>
            )}

            {source === "upload" && (
              <label className="mt-5 flex cursor-pointer flex-col items-center justify-center gap-2 overflow-hidden rounded-xl border-2 border-dashed border-zinc-300 bg-zinc-50 p-4 text-center hover:border-zinc-500">
                {preview ? (
                  // eslint-disable-next-line @next/next/no-img-element -- a local object URL
                  <img src={preview} alt="Your photo" className="max-h-64 rounded-lg object-contain" />
                ) : (
                  <>
                    <span className="text-3xl text-zinc-400">+</span>
                    <span className="text-sm font-medium">Take or choose a photo</span>
                  </>
                )}
                <span className="text-xs text-zinc-500">{preview ? "Tap to choose another" : "Its location and time are read from the photo when they are in it."}</span>
                <input type="file" accept="image/jpeg,image/png,image/webp,image/heic,image/heif" onChange={(e) => void choosePhoto(e.target.files?.[0] ?? null)} className="sr-only" />
              </label>
            )}
            {source === "upload" && (
              <div className="mt-3 rounded-xl bg-zinc-50 px-3.5 py-3 text-xs text-zinc-600">
                <p className="mb-2 rounded-lg bg-white px-2.5 py-2 text-zinc-700 ring-1 ring-zinc-200">
                  Your own photo runs live: Muse Spark and SAM 3.1 check it in about a minute. It needs the demo access code, which you enter in the
                  last step. To compare it with an incident, put the pin on that incident&apos;s dot in the next step. Without the code, pick a sample
                  photo, or use &ldquo;Run it live&rdquo; on the demo page.
                </p>
                <p className="font-medium text-zinc-900">What makes a photo easy to match</p>
                <p className="mt-1">
                  Keep what stays put in the frame: a shop sign, a door, a pole, the curb. That is what tells this spot from the one next to it. A close-up of the
                  damage alone usually gets a question back asking for a second, wider photo.
                </p>
              </div>
            )}

            {source === "none" && (
              <div className="mt-5 space-y-3">
                <p className="text-sm text-zinc-600">
                  Without a photo, the system never matches your report to an existing one on its own: it may ask you for a photo, and staff see the incidents nearby.
                  Pick a sample message, or write your own in the last step.
                </p>
                <ul className="grid gap-2 sm:grid-cols-2">
                  {messages.map((m) => {
                    const active = voiceSample?.id === m.id || (m.kind === "text" && description === m.text);
                    return (
                      <li key={m.id}>
                        <button
                          type="button"
                          onClick={() => (pickMessage(m), setError(null))}
                          className={`w-full rounded-xl border p-3 text-left text-sm transition ${active ? "border-zinc-900 bg-zinc-50 ring-1 ring-zinc-900" : "border-zinc-200 hover:border-zinc-300"}`}
                        >
                          <span className="flex items-center gap-2 font-medium">
                            {m.kind === "voice" ? "🎙" : "✎"} {m.title}
                            {m.kind === "voice" && <SyntheticBadge />}
                          </span>
                          <span className="mt-1 block text-xs text-zinc-600">“{m.text}”</span>
                        </button>
                      </li>
                    );
                  })}
                </ul>
              </div>
            )}
          </Step>
        )}

        {step === 1 && (
          <Step
            title="Where is it?"
            hint="Tap the map where the problem is. Dots are incidents already on file (red: open, green: fixed). Tap one to report there, since a report is compared only with incidents near its pin."
          >
            <div className="relative h-[46vh] min-h-[280px] overflow-hidden rounded-xl border border-zinc-200">
              <PinMap
                lat={latN}
                lng={lngN}
                places={places}
                onPick={(a, b) => {
                  setLat(a.toFixed(6));
                  setLng(b.toFixed(6));
                  setError(null);
                }}
              />
              <button
                type="button"
                onClick={locate}
                className="absolute bottom-3 right-3 z-[500] rounded-full bg-white px-3 py-2 text-sm font-medium shadow-md ring-1 ring-zinc-200 hover:bg-zinc-50"
              >
                ◎ My location
              </button>
            </div>
            <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-2">
              <label className="text-sm text-zinc-700">
                Jump to an incident on file:{" "}
                <select
                  value=""
                  onChange={(e) => {
                    const p = places.find((x) => x.id === e.target.value);
                    if (p) {
                      setLat(p.lat.toFixed(6));
                      setLng(p.lng.toFixed(6));
                      setError(null);
                    }
                  }}
                  className="ml-1 rounded-md border border-zinc-300 bg-white px-2 py-1 text-sm"
                >
                  <option value="">Choose…</option>
                  {[...places]
                    .sort((a, b) => a.title.localeCompare(b.title))
                    .map((p) => (
                      <option key={p.id} value={p.id}>
                        {p.title} ({p.open ? "open" : "fixed"})
                      </option>
                    ))}
                </select>
              </label>
              <span className="font-mono text-xs text-zinc-500">{latN !== null && lngN !== null ? `${latN.toFixed(5)}, ${lngN.toFixed(5)}` : "No pin yet"}</span>
            </div>
            {nearest && (
              <p className="mt-1.5 text-xs text-zinc-600">
                Nearest incident on file: the {nearest.place.title}, {Math.round(nearest.m)} m away.{" "}
                {source === "none"
                  ? "Without a photo nothing is compared; staff see the incidents nearby."
                  : nearest.m <= COMPARE_RADIUS_M
                    ? "Your photo will be compared with it."
                    : `Only incidents within about ${COMPARE_RADIUS_M} m are compared, so this would be a new report.`}
              </p>
            )}
            {source === "sample" && picked && <Note tone="ok">{picked.observed_at ? "Set from the 311 request: where it was reported." : "Set from the sample photo."}</Note>}
            {source === "upload" && exif && (
              <Note tone={exif.lat && lat === exif.lat && lng === exif.lng ? "ok" : "plain"}>
                {!exif.lat
                  ? "This photo has no location in it. Tap the map or use your location."
                  : lat === exif.lat && lng === exif.lng
                    ? "Read from the photo: where it was taken."
                    : "Moved from the location in the photo."}
              </Note>
            )}

            <h3 className="mt-6 text-sm font-medium">When did you see it?</h3>
            <div className="mt-2 flex flex-wrap gap-2">
              {(["now", "earlier", "custom"] as const).map((w) => (
                <button key={w} type="button" className={chip(when === w)} onClick={() => setWhen(w)}>
                  {w === "now" ? "Just now" : w === "earlier" ? "Earlier today" : "Pick a time"}
                </button>
              ))}
            </div>
            {when === "custom" && <input type="datetime-local" value={custom} onChange={(e) => setCustom(e.target.value)} className={`${input} mt-2`} />}
            {source === "upload" && exif?.time && when === "custom" && custom === exif.time && <Note tone="ok">Read from the photo: when it was taken.</Note>}
            {source === "sample" && picked?.observed_at && when === "custom" && custom === localInput(picked.observed_at) && (
              <Note tone="ok">From the 311 request: when it was reported ({picked.reported}).</Note>
            )}
          </Step>
        )}

        {step === 2 && (
          <Step title="Anything to add?" hint={source === "none" ? "Type or record what you saw." : "Optional. A few words help staff."}>
            <div className="flex items-center gap-3 rounded-xl border border-zinc-200 p-2.5">
              {thumb ? (
                // eslint-disable-next-line @next/next/no-img-element -- resized by our image route or a local object URL
                <img src={thumb} alt="" className="h-12 w-16 rounded-md object-cover" />
              ) : (
                <span className="flex h-12 w-16 items-center justify-center rounded-md bg-zinc-100 text-xs text-zinc-500">No photo</span>
              )}
              <div className="min-w-0 text-xs text-zinc-600">
                <p className="truncate font-medium text-zinc-900">{picked ? (picked.observed_at ? picked.title : `${tileTitle(picked.title).place} · ${tileTitle(picked.title).view}`) : (file?.name ?? "Message only")}</p>
                <p className="font-mono">{latN !== null && lngN !== null ? `${latN.toFixed(5)}, ${lngN.toFixed(5)}` : "not set"}</p>
              </div>
              <button type="button" onClick={() => setStep(0)} className="ml-auto text-xs font-medium text-zinc-900 underline underline-offset-2">
                Change
              </button>
            </div>

            <label className="mt-5 block text-sm font-medium">
              What is it?
              <select value={category} onChange={(e) => setCategory(e.target.value as Category | "")} className={`${input} mt-1.5 font-normal`}>
                <option value="">Not sure</option>
                {CATEGORIES.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.text}
                  </option>
                ))}
              </select>
            </label>

            <label className="mt-4 block text-sm font-medium">
              Message
              <textarea value={description} onChange={(e) => setDescription(e.target.value)} rows={3} maxLength={MAX_DESCRIPTION_CHARS} className={`${input} mt-1.5 font-normal`} placeholder="What is wrong, and where exactly?" />
            </label>
            <div className="mt-2">
              {voiceSample ? (
                <div className="space-y-1.5 rounded-lg bg-zinc-50 p-2.5">
                  <p className="flex items-center gap-2 text-xs">
                    Sample recording <SyntheticBadge />
                    <button type="button" onClick={() => setVoiceSample(null)} className="ml-auto text-zinc-500 hover:underline">
                      Remove
                    </button>
                  </p>
                  <audio controls src={`/api/samples/messages/${voiceSample.id}/audio`} className="h-9 w-full" />
                </div>
              ) : (
                <Recorder value={recording} onChange={record} />
              )}
              <p className="mt-1.5 text-xs text-zinc-500">Recordings are transcribed by Muse Voice Transcribe. Your own recording needs the access code; the sample recordings do not.</p>
            </div>

            {needsCode && (
              <label className="mt-5 block text-sm font-medium">
                Demo access code
                <input value={accessCode} onChange={(e) => setAccessCode(e.target.value)} className={`${input} mt-1.5 font-normal`} placeholder="Access code" />
                <span className="mt-1 block text-xs font-normal text-zinc-500">
                  Your own photo or recording is analyzed live, so it needs the code. Anyone on the staff console can see it.
                </span>
              </label>
            )}

            <div className="mt-5 space-y-2 rounded-xl border border-rose-200 bg-rose-50 px-3.5 py-3 text-xs text-rose-900">
              <p>Fire, a gas smell, a fallen power line or anyone hurt: call 911 first.</p>
              <label className="flex items-center gap-2 text-sm font-medium">
                <input type="checkbox" checked={danger} onChange={(e) => setDanger(e.target.checked)} className="h-4 w-4 accent-rose-600" />
                Someone may be in danger right now
              </label>
              <p>If you check this box or describe the danger in your message, the report goes to the top of the staff queue.</p>
            </div>
          </Step>
        )}
      </div>

      {error && <p className="mt-4 rounded-lg bg-rose-50 px-3 py-2 text-sm text-rose-800">{error}</p>}

      {/* On a phone the step buttons stay under the thumb. */}
      <div className="sticky bottom-0 -mx-4 mt-6 flex gap-2 border-t border-zinc-200 bg-white/95 px-4 py-3 backdrop-blur sm:static sm:mx-0 sm:border-0 sm:bg-transparent sm:px-0">
        {step > 0 && (
          <button type="button" onClick={() => (setError(null), setStep(step - 1))} className="rounded-lg border border-zinc-300 px-4 py-3 text-sm font-medium hover:bg-zinc-50">
            Back
          </button>
        )}
        <button disabled={busy || (paused && step === STEPS.length - 1)} className="flex-1 rounded-lg bg-zinc-900 px-4 py-3 text-sm font-semibold text-white hover:bg-zinc-800 disabled:opacity-50 sm:flex-none sm:px-8">
          {step < STEPS.length - 1 ? "Next" : busy ? "Sending…" : "Send report"}
        </button>
      </div>
      <p className="mt-3 text-center text-xs text-zinc-500 sm:text-left">The system only suggests. City staff decide what happens to every report.</p>
    </form>
  );
}

function Progress({ step, onJump }: { step: number; onJump: (at: number) => void }) {
  return (
    <ol className="flex items-center gap-2">
      {STEPS.map((name, i) => (
        <li key={name} className="flex flex-1 items-center gap-2">
          <button
            type="button"
            onClick={() => onJump(i)}
            disabled={i >= step}
            className={`flex h-7 w-7 shrink-0 items-center justify-center rounded-full text-xs font-semibold ${
              i < step ? "bg-zinc-900 text-white" : i === step ? "bg-white text-zinc-900 ring-2 ring-zinc-900" : "bg-zinc-100 text-zinc-400"
            }`}
          >
            {i < step ? "✓" : i + 1}
          </button>
          <span className={`text-sm ${i === step ? "font-medium text-zinc-900" : "text-zinc-500"}`}>{name}</span>
          {i < STEPS.length - 1 && <span className={`h-px flex-1 ${i < step ? "bg-zinc-900" : "bg-zinc-200"}`} />}
        </li>
      ))}
    </ol>
  );
}

// A tile names the object and the view, not the photo's state: the state is what the system has to find out.
// The place, and the view that tells the photos of one place apart; the state is left out, so the tile does not
// give the answer away.
// The search radius for every kind but benches (30 m); what the form tells a resident before the kind is known.
const COMPARE_RADIUS_M = 40;

// A generated sample's title is "place, state, view" (lib/dataset/static.ts).
function tileTitle(title: string): { place: string; state: string; view: string } {
  const parts = title.split(", ");
  return parts.length === 3 ? { place: parts[0]!, state: parts[1]!, view: parts[2]! } : { place: title, state: "", view: "" };
}

function Step({ title, hint, children }: { title: string; hint: string; children: ReactNode }) {
  return (
    <section>
      <h2 className="text-lg font-semibold tracking-tight">{title}</h2>
      <p className="mt-1 text-sm text-zinc-600">{hint}</p>
      <div className="mt-4">{children}</div>
    </section>
  );
}

function Note({ tone, children }: { tone: "ok" | "plain"; children: ReactNode }) {
  return <p className={`mt-1.5 text-xs ${tone === "ok" ? "text-emerald-700" : "text-zinc-500"}`}>{children}</p>;
}
