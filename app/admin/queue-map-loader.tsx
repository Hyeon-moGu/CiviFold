// Author: HyeonMo Gu
// Created: 2026-10-27

"use client";

import dynamic from "next/dynamic";

// Leaflet needs the browser's window, so the map renders on the client only.
export const QueueMapLoader = dynamic(() => import("./queue-map"), {
  ssr: false,
  loading: () => <div className="flex h-full items-center justify-center text-xs text-ops-dim">Loading map…</div>,
});
