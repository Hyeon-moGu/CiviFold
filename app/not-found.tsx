// Author: HyeonMo Gu
// Created: 2026-11-04

import Link from "next/link";

export default function NotFound() {
  return (
    <main className="mx-auto max-w-xl px-4 py-24 text-center">
      <h1 className="text-2xl font-semibold tracking-tight text-zinc-900">This page does not exist.</h1>
      <p className="mt-3 text-zinc-600">The guided demo shows every case CiviFold handles.</p>
      <p className="mt-6 flex justify-center gap-5 text-sm font-medium">
        <Link href="/demo" className="rounded-lg bg-zinc-900 px-4 py-2.5 text-white hover:bg-zinc-800">
          Open the demo
        </Link>
        <Link href="/" className="px-2 py-2.5 text-zinc-900 underline underline-offset-4">
          Home
        </Link>
      </p>
    </main>
  );
}
