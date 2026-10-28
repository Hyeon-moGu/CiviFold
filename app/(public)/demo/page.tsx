// Author: HyeonMo Gu
// Created: 2026-10-27

import { SCENARIOS } from "@/lib/demo/scenarios";
import { DemoRunner } from "./demo-runner";

export const metadata = { title: "Demo · CiviFold" };

export default function DemoPage() {
  return (
    <main className="mx-auto max-w-4xl px-4 py-8">
      <h1 className="text-2xl font-semibold tracking-tight">Try CiviFold in a few clicks</h1>
      <p className="mt-2 max-w-2xl text-sm text-zinc-600">
        Sixteen places in a fictional district each have one open incident. Each scenario sends resident reports (synthetic photos, typed messages or
        synthetic voice recordings) and shows what the system suggests to city staff. Start with a reset so every scenario begins from the same state.
      </p>
      <DemoRunner scenarios={SCENARIOS.map(({ id, title, story, steps }) => ({ id, title, story, steps: steps.map((s) => ({ text: s.text, expect: s.kind === "repair" ? null : s.expect, urgent: s.kind === "message" && Boolean(s.urgent) })) }))} />
    </main>
  );
}
