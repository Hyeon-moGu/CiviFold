// Author: HyeonMo Gu
// Created: 2026-10-27

import { describe, expect, it } from "vitest";
import { checkWav } from "./voice";

function wav({ rate = 24_000, channels = 1, bits = 16, format = 1, samples = 24_000 } = {}): Buffer {
  const data = samples * channels * (bits / 8);
  const b = Buffer.alloc(44 + data);
  b.write("RIFF", 0, "ascii");
  b.writeUInt32LE(36 + data, 4);
  b.write("WAVE", 8, "ascii");
  b.write("fmt ", 12, "ascii");
  b.writeUInt32LE(16, 16);
  b.writeUInt16LE(format, 20);
  b.writeUInt16LE(channels, 22);
  b.writeUInt32LE(rate, 24);
  b.writeUInt32LE(rate * channels * (bits / 8), 28);
  b.writeUInt16LE(channels * (bits / 8), 32);
  b.writeUInt16LE(bits, 34);
  b.write("data", 36, "ascii");
  b.writeUInt32LE(data, 40);
  return b;
}

describe("checkWav", () => {
  it("reads rate and length of what the endpoint accepts", () => {
    expect(checkWav(wav())).toEqual({ sampleRate: 24_000, durationMs: 1000 });
    expect(checkWav(wav({ rate: 16_000, samples: 8_000 }))).toEqual({ sampleRate: 16_000, durationMs: 500 });
  });

  it.each([
    ["stereo", wav({ channels: 2 }), "WAV must be mono"],
    ["44.1 kHz", wav({ rate: 44_100 }), "WAV must be 16 or 24 kHz"],
    ["8-bit", wav({ bits: 8 }), "WAV must be 16-bit PCM"],
    ["float", wav({ format: 3, bits: 32 }), "WAV must be 16-bit PCM"],
    ["webm", Buffer.from("1a45dfa3".padEnd(100, "0"), "hex"), "not a WAV file"],
  ])("rejects %s", (_, bytes, why) => expect(checkWav(bytes)).toBe(why));
});
