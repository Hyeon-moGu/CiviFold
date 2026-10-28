// Author: HyeonMo Gu
// Created: 2026-10-27

import Link from "next/link";
import type { ReactNode } from "react";
import { Mark } from "@/app/_ui/mark";

export default function PublicLayout({ children }: { children: ReactNode }) {
  return (
    <div className="min-h-screen bg-white text-zinc-900">
      <div className="bg-zinc-900 px-4 py-1.5 text-center text-[11px] font-medium tracking-wide text-zinc-300">
        DEMO · sample photos are synthetic · the system only suggests, city staff decide
      </div>
      <header className="sticky top-0 z-20 border-b border-zinc-200 bg-white/90 backdrop-blur">
        <nav className="mx-auto flex max-w-6xl items-center gap-5 px-4 py-3 text-sm">
          <Link href="/" className="flex items-center gap-2 font-semibold tracking-tight">
            <Mark />
            CiviFold
          </Link>
          <Link href="/report" className="text-zinc-600 hover:text-zinc-900">
            Report
          </Link>
          <Link href="/demo" className="text-zinc-600 hover:text-zinc-900">
            Demo
          </Link>
          <Link href="/admin" className="ml-auto rounded-md bg-zinc-900 px-3 py-1.5 text-xs font-medium text-white hover:bg-zinc-700">
            Staff console
          </Link>
        </nav>
      </header>
      {children}
    </div>
  );
}
