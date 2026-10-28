// Author: HyeonMo Gu
// Created: 2026-10-27

import { createHash } from "node:crypto";
import { metaCall, type CallInfo, type Mode } from "./call";
import { metaPostForm, MODELS } from "./client";
import { VOICE_PER_HOUR } from "./pricing";
import { RetryableError } from "./retry";

type TranscribeResponse = { sessionId?: string; transcript?: string; audioDurationMs?: number };

export type WavInfo = { sampleRate: number; durationMs: number };

// The file endpoint accepts only RIFF/WAVE, mono, 16-bit PCM at 16 or 24 kHz.
const RATES = new Set([16_000, 24_000]);

/** Reads a WAV header; returns why the endpoint would reject the file, or its rate and length. */
export function checkWav(bytes: Buffer): WavInfo | string {
  if (bytes.length < 44 || bytes.toString("ascii", 0, 4) !== "RIFF" || bytes.toString("ascii", 8, 12) !== "WAVE") return "not a WAV file";
  let offset = 12;
  let format: { channels: number; rate: number; bits: number; pcm: boolean } | null = null;
  while (offset + 8 <= bytes.length) {
    const id = bytes.toString("ascii", offset, offset + 4);
    const size = bytes.readUInt32LE(offset + 4);
    const body = offset + 8;
    if (id === "fmt ") {
      format = { pcm: bytes.readUInt16LE(body) === 1, channels: bytes.readUInt16LE(body + 2), rate: bytes.readUInt32LE(body + 4), bits: bytes.readUInt16LE(body + 14) };
    } else if (id === "data") {
      if (!format) return "WAV data before its format";
      if (!format.pcm || format.bits !== 16) return "WAV must be 16-bit PCM";
      if (format.channels !== 1) return "WAV must be mono";
      if (!RATES.has(format.rate)) return "WAV must be 16 or 24 kHz";
      const samples = Math.min(size, bytes.length - body) / 2;
      return { sampleRate: format.rate, durationMs: Math.round((samples / format.rate) * 1000) };
    }
    offset = body + size + (size % 2);
  }
  return "WAV has no audio data";
}

// Words residents use for the things the city fixes; they bias recognition, not the output.
const KEYWORDS = ["fire hydrant", "street light", "traffic sign", "bench", "pothole", "sidewalk", "graffiti", "illegal dumping", "mattress"];

/** Speech to text with Muse Voice Transcribe. No language is forced: the model detects it. */
export async function transcribe(wav: Buffer, opts: { mode?: Mode } = {}): Promise<{ transcript: string; duration_ms: number; call: CallInfo }> {
  const request = { mode: "PUSH_TO_TALK", model: MODELS.voice, audioEncoding: "WAV", emitAudioProgress: false, keywords: KEYWORDS };
  const key = { ...request, audio_sha256: createHash("sha256").update(wav).digest("hex") };
  const send = () => {
    const form = new FormData();
    form.append("request", new Blob([JSON.stringify(request)], { type: "application/json" }));
    form.append("audio", new Blob([new Uint8Array(wav)], { type: "audio/wav" }), "audio.wav");
    return metaPostForm<TranscribeResponse>("asr/transcribe", form);
  };
  const { response, call } = await metaCall<TranscribeResponse>({
    model: MODELS.voice,
    request: key,
    mode: opts.mode,
    send,
    cost: (res) => (Math.floor((res.audioDurationMs ?? 0) / 1000) / 3600) * VOICE_PER_HOUR,
    validate: (res) => {
      if (typeof res.transcript !== "string") throw new RetryableError("Muse Voice Transcribe returned no transcript");
    },
  });
  return { transcript: response.transcript!.trim().replace(/\.{2,}$/, "."), duration_ms: response.audioDurationMs ?? 0, call };
}
