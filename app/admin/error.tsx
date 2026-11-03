// Author: HyeonMo Gu
// Created: 2026-11-04

"use client";

import Link from "next/link";
import { useEffect } from "react";

// A staff page that failed to load. Nothing was decided by the failure: suggestions only change on a staff click.
export default function StaffError({ error, retry }: { error: unknown; retry: () => void }) {
  useEffect(() => console.error(error), [error]);
  return (
    <main className="mx-auto max-w-[1400px] px-4 py-16">
      <h1 className="text-lg font-semibold text-white">This page did not load.</h1>
      <p className="mt-2 text-sm text-ops-dim">Nothing was changed. Try again, or go back to the queue.</p>
      <p className="mt-5 flex items-center gap-4 text-sm">
        <button onClick={() => retry()} className="rounded-md bg-white px-3.5 py-1.5 font-semibold text-black hover:bg-zinc-200">
          Try again
        </button>
        <Link href="/admin" className="text-ops-dim underline underline-offset-4 hover:text-white">
          Staff queue
        </Link>
      </p>
    </main>
  );
}
