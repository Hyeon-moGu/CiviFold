// Author: HyeonMo Gu
// Created: 2026-10-28

import { beforeEach, describe, expect, it, vi } from "vitest";
import { memoryStore, setCacheStore } from "./cache";
import { CacheMissError, metaCall } from "./call";
import { replayForm } from "./replay";

const turn = (report: string, photo: string, at: string) => ({
  input: [{ role: "user", content: `REPORT ${report}; photos ${photo}, syn_H1_damaged_v1_front; observed at: ${at}` }],
});
const answer = (photo: string) => ({ output: [{ type: "function_call", name: "compare_images", arguments: JSON.stringify({ new_image_id: photo }) }] });

function call(request: unknown, send: () => Promise<unknown>, mode: "live" | "cached" = "cached") {
  return metaCall({ model: "m", request, send, cost: () => 0.01, mode, replay: replayForm(request), retry: { baseMs: 1 } });
}

beforeEach(() => setCacheStore(memoryStore()));

describe("replay form", () => {
  it("replays a turn whose minted ids and times changed, with the new run's ids", async () => {
    const recorded = turn("rep_ee90328897", "img_0a1b2c3d4e", "2026-10-27T03:12:45.123Z");
    await call(recorded, async () => answer("img_0a1b2c3d4e"), "live");
    const send = vi.fn();
    const { response, call: info } = await call(turn("rep_1234567890", "img_ffffffffff", "2026-11-02T18:00:00.000Z"), send);
    expect(send).not.toHaveBeenCalled();
    expect(info.cached).toBe(true);
    expect(response).toEqual(answer("img_ffffffffff"));
  });

  it("keeps fixed ids, so a turn about another seeded photo still misses", async () => {
    await call(turn("rep_ee90328897", "img_0a1b2c3d4e", "2026-10-27T03:12:45Z"), async () => answer("img_0a1b2c3d4e"), "live");
    const other = { input: [{ role: "user", content: "REPORT rep_1234567890; photos img_ffffffffff, syn_H5_damaged_v1_front; observed at: 2026-10-27T03:12:45Z" }] };
    await expect(call(other, vi.fn())).rejects.toBeInstanceOf(CacheMissError);
  });

  it("tells ids apart by where they first appear", () => {
    const a = replayForm({ x: "img_aaaaaaaaaa img_bbbbbbbbbb" });
    const b = replayForm({ x: "img_bbbbbbbbbb img_aaaaaaaaaa" });
    const c = replayForm({ x: "img_aaaaaaaaaa img_aaaaaaaaaa" });
    expect(a.key).toBe(b.key);
    expect(a.key).not.toBe(c.key);
  });
});
