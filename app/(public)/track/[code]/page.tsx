// Author: HyeonMo Gu
// Created: 2026-10-27

import { TrackView } from "./track-view";

export const metadata = { title: "Your report · CiviFold" };

export default async function TrackPage({ params }: { params: Promise<{ code: string }> }) {
  const { code } = await params;
  return (
    <main className="mx-auto max-w-3xl px-4 py-8">
      <TrackView code={code} />
    </main>
  );
}
