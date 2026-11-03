// Author: HyeonMo Gu
// Created: 2026-10-27

import Link from "next/link";
import type { ReactNode } from "react";
import { defaultMode } from "@/lib/meta/call";
import { liveDailyUsd } from "@/lib/server/runtime";
import { Mark } from "@/app/_ui/mark";

export const dynamic = "force-dynamic";

// The staff console: dark, dense, built for reading evidence quickly. Every suggestion waits for a person.
export default function ConsoleLayout({ children }: { children: ReactNode }) {
  const mode = defaultMode();
  // A replay-only deployment with a live budget replays recorded calls and runs the rest live.
  const models = mode !== "cached" ? "live" : liveDailyUsd() > 0 ? "replay first, then live" : "replay";
  return (
    <div className="ops min-h-screen bg-ops-bg text-ops-text">
      <header className="sticky top-0 z-[1000] border-b border-ops-line bg-ops-bg/95 backdrop-blur">
        <nav className="mx-auto flex max-w-[1400px] items-center gap-4 px-4 py-2.5 text-sm sm:gap-6">
          <Link href="/admin" className="flex items-center gap-2 font-semibold tracking-tight text-white">
            <Mark className="h-4 w-4 text-white" />
            CiviFold <span className="hidden font-normal text-ops-dim sm:inline">/ staff console</span>
          </Link>
          <Link href="/demo" className="text-ops-dim hover:text-white">
            Demo<span className="hidden sm:inline"> scenarios</span>
          </Link>
          <span className="ml-auto flex items-center gap-3 font-mono text-[11px] text-ops-dim">
            <span className="hidden items-center gap-1.5 sm:flex">
              <span className={`h-1.5 w-1.5 rounded-full ${mode === "cached" ? "bg-amber-400" : "bg-emerald-400"}`} />
              models: {models}
            </span>
            <span className="hidden sm:inline">suggestions only · staff decide</span>
          </span>
        </nav>
      </header>
      {children}
    </div>
  );
}
