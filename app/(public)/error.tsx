// Author: HyeonMo Gu
// Created: 2026-11-04

"use client";

import Link from "next/link";
import { useEffect } from "react";

// A page that failed to load: the visitor can try it again or go on with the guided demo.
export default function PublicError({ error, retry }: { error: unknown; retry: () => void }) {
  useEffect(() => console.error(error), [error]);
  return (
    <main className="mx-auto max-w-xl px-4 py-24 text-center">
      <h1 className="text-2xl font-semibold tracking-tight text-zinc-900">This page did not load.</h1>
      <p className="mt-3 text-zinc-600">It is usually a moment&apos;s hiccup. Try again, or go on with the guided demo.</p>
      <p className="mt-6 flex justify-center gap-5 text-sm font-medium">
        <button onClick={() => retry()} className="rounded-lg bg-zinc-900 px-4 py-2.5 text-white hover:bg-zinc-800">
          Try again
        </button>
        <Link href="/demo" className="px-2 py-2.5 text-zinc-900 underline underline-offset-4">
          Open the demo
        </Link>
      </p>
    </main>
  );
}
