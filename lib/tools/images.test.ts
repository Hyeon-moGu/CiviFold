// Author: HyeonMo Gu
// Created: 2026-10-31

import { describe, expect, it, vi } from "vitest";
import { memoizedImages, memoryImages, type ImageRow } from "./images";

const row = (id: string): ImageRow => ({ id, report_id: "r1", kind: "original", source_image_id: null, width: 1, height: 1, mime: "image/png", is_synthetic: true });

describe("memoizedImages", () => {
  it("reads each row and each image's bytes once, even when asked at the same time", async () => {
    const inner = memoryImages({ images: [{ row: row("img_1"), bytes: Buffer.from("one") }] });
    const get = vi.spyOn(inner, "get");
    const bytes = vi.spyOn(inner, "bytes");
    const store = memoizedImages(inner);
    const [a, b] = await Promise.all([store.bytes("img_1"), store.bytes("img_1")]);
    expect(a.toString()).toBe("one");
    expect(b).toBe(a);
    await store.get("img_1");
    expect(await store.get("img_1")).toEqual(row("img_1"));
    expect(bytes).toHaveBeenCalledTimes(1);
    expect(get).toHaveBeenCalledTimes(1);
  });

  it("does not remember a missing row, and serves a put without reading it back", async () => {
    const inner = memoryImages();
    const get = vi.spyOn(inner, "get");
    const bytes = vi.spyOn(inner, "bytes");
    const store = memoizedImages(inner);
    expect(await store.get("img_2")).toBeNull();
    await store.put(row("img_2"), Buffer.from("two"));
    expect(await store.get("img_2")).toEqual(row("img_2"));
    expect((await store.bytes("img_2")).toString()).toBe("two");
    expect(get).toHaveBeenCalledTimes(1);
    expect(bytes).not.toHaveBeenCalled();
  });

  it("retries a read that failed", async () => {
    const inner = memoryImages();
    const bytes = vi.spyOn(inner, "bytes");
    const store = memoizedImages(inner);
    await expect(store.bytes("img_3")).rejects.toThrow("Unknown image img_3");
    await inner.put(row("img_3"), Buffer.from("three"));
    expect((await store.bytes("img_3")).toString()).toBe("three");
    expect(bytes).toHaveBeenCalledTimes(2);
  });
});
