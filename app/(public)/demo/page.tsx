// Author: HyeonMo Gu
// Created: 2026-10-27

import { imageId } from "@/lib/dataset/assets";
import { messageSample } from "@/lib/dataset/messages";
import { ASSET_FILE } from "@/lib/dataset/static";
import { SCENARIOS } from "@/lib/demo/scenarios";
import { DemoRunner, type ScenarioView } from "./demo-runner";

export const metadata = { title: "Demo · CiviFold" };

const sampleImage = (id: string) => `/api/samples/${id}/image?w=480`;

function view(): ScenarioView[] {
  const assets = new Map(ASSET_FILE.assets.map((a) => [a.id, a]));
  return SCENARIOS.map(({ id, title, story, world, steps }) => ({
    id,
    title,
    story,
    world: world.map((assetId) => {
      const a = assets.get(assetId)!;
      return { title: `${a.object_short} by the ${a.sign_texts[0]}`, photo: `/api/images/${imageId(a.id, "damaged_v1", "front")}?w=480` };
    }),
    steps: steps.map((s) => {
      const base = { kind: s.kind, text: s.text, why: s.why, expect: s.kind === "repair" || s.kind === "brief" || s.kind === "decide" ? null : s.expect, urgent: s.kind === "message" && Boolean(s.urgent) };
      if (s.kind === "report" || s.kind === "answer") return { ...base, photo: sampleImage(s.sample) };
      if (s.kind === "message") {
        const m = messageSample(s.message)!;
        return { ...base, message: { kind: m.kind, text: m.text, audio: m.kind === "voice" ? `/api/samples/messages/${m.id}/audio` : null } };
      }
      return base;
    }),
  }));
}

export default function DemoPage() {
  return (
    <main className="mx-auto max-w-4xl px-4 py-8">
      <h1 className="text-2xl font-semibold tracking-tight">Try CiviFold in a few clicks</h1>
      <p className="mt-2 max-w-2xl text-sm text-zinc-600">
        Sixteen places in a fictional district each have one open incident. Each scenario sends resident reports (synthetic photos, typed messages or
        synthetic voice recordings) and shows what the system suggests to city staff. Model results are replayed from recorded runs, so the public demo
        makes no new model calls. The world is shared with other visitors: steps already run show their result, and Reset puts everything back to the
        start.
      </p>
      <DemoRunner scenarios={view()} />
    </main>
  );
}
