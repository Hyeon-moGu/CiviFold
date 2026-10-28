// Author: HyeonMo Gu
// Created: 2026-10-27

"use client";

import { useEffect, useRef, useState } from "react";
import { toWav } from "@/app/_ui/wav";

const MAX_MS = 60_000;

/** Records up to a minute from the microphone and hands back a WAV the transcription endpoint accepts. */
export function Recorder({ value, onChange }: { value: Blob | null; onChange: (wav: Blob | null) => void }) {
  const [state, setState] = useState<"idle" | "recording" | "encoding">("idle");
  const [error, setError] = useState<string | null>(null);
  const [elapsed, setElapsed] = useState(0);
  const recorder = useRef<MediaRecorder | null>(null);
  const url = useRef<string | null>(null);
  const [src, setSrc] = useState<string | null>(null);

  useEffect(() => {
    if (url.current) URL.revokeObjectURL(url.current);
    url.current = value ? URL.createObjectURL(value) : null;
    setSrc(url.current);
  }, [value]);

  async function start() {
    setError(null);
    let stream: MediaStream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    } catch {
      return setError("The browser did not allow the microphone.");
    }
    const chunks: Blob[] = [];
    const rec = new MediaRecorder(stream);
    const began = Date.now();
    const tick = setInterval(() => {
      setElapsed(Date.now() - began);
      if (Date.now() - began >= MAX_MS) rec.stop();
    }, 250);
    rec.ondataavailable = (e) => chunks.push(e.data);
    rec.onstop = async () => {
      clearInterval(tick);
      stream.getTracks().forEach((t) => t.stop());
      setState("encoding");
      try {
        onChange(await toWav(new Blob(chunks, { type: rec.mimeType })));
      } catch {
        setError("The recording could not be read.");
      }
      setState("idle");
    };
    recorder.current = rec;
    rec.start();
    setElapsed(0);
    setState("recording");
  }

  const button = "rounded-lg border border-zinc-300 px-3 py-2 text-sm hover:bg-zinc-50";
  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center gap-2">
        {state === "recording" ? (
          <button type="button" onClick={() => recorder.current?.stop()} className="rounded-lg bg-rose-600 px-3 py-2 text-sm font-medium text-white">
            ■ Stop · {Math.floor(elapsed / 1000)}s
          </button>
        ) : (
          <button type="button" onClick={start} disabled={state === "encoding"} className={button}>
            {state === "encoding" ? "Preparing…" : value ? "● Record again" : "● Record a message"}
          </button>
        )}
        {value && state === "idle" && (
          <button type="button" onClick={() => onChange(null)} className="text-sm text-zinc-500 hover:underline">
            Remove
          </button>
        )}
      </div>
      {src && state === "idle" && <audio controls src={src} className="h-9 w-full" />}
      {error && <p className="text-xs text-rose-700">{error}</p>}
    </div>
  );
}
