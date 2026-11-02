// Author: HyeonMo Gu
// Created: 2026-11-02

import { readFile } from "node:fs/promises";
import sharp from "sharp";
import { describe, expect, it } from "vitest";
import { VIEW_SIZE, type View } from "./assets";

type Entry = { id: string; view: View };

describe("VIEW_SIZE", () => {
  // A sample report stores this size without opening the photo, so it must hold for every one of them.
  it("is the real size of every dataset photo", async () => {
    const manifest = JSON.parse(await readFile("dataset/manifest.json", "utf8")) as Entry[];
    expect(manifest.length).toBeGreaterThan(0);
    const wrong: string[] = [];
    for (const { id, view } of manifest) {
      const { width, height } = await sharp(`dataset/images/${id}.webp`).metadata();
      if (width !== VIEW_SIZE[view].width || height !== VIEW_SIZE[view].height) wrong.push(`${id}: ${width}x${height}`);
    }
    expect(wrong).toEqual([]);
  }, 60_000);
});
