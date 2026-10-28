// Author: HyeonMo Gu
// Created: 2026-10-27

// Records the sample voice messages with macOS text-to-speech, as 24 kHz mono 16-bit WAV
// (what Muse Voice Transcribe accepts). macOS only: needs `say` and `afconvert`.
import { execFile } from "node:child_process";
import { mkdir, readFile, rm } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { messageSamples, VOICE_DIR } from "../lib/dataset/messages";
import { checkWav } from "../lib/meta/voice";

const run = promisify(execFile);

await mkdir(VOICE_DIR, { recursive: true });
for (const m of messageSamples().filter((s) => s.kind === "voice")) {
  const aiff = path.join(VOICE_DIR, `${m.id}.aiff`);
  const wav = path.join(VOICE_DIR, `${m.id}.wav`);
  await run("say", ["-v", m.voice!, "-o", aiff, m.text]);
  await run("afconvert", ["-f", "WAVE", "-d", "LEI16@24000", "-c", "1", aiff, wav]);
  await rm(aiff);
  const info = checkWav(await readFile(wav));
  if (typeof info === "string") throw new Error(`${wav}: ${info}`);
  console.log(`${wav} · ${(info.durationMs / 1000).toFixed(1)} s`);
}
