// Author: HyeonMo Gu
// Created: 2026-11-03

"use client";

import { useLinkStatus } from "next/link";

/** A small spinner inside a Link while the page it opens loads, so a click never looks ignored. */
export function LinkPending({ className = "" }: { className?: string }) {
  const { pending } = useLinkStatus();
  return pending ? <span aria-hidden className={`inline-block h-3 w-3 shrink-0 animate-spin rounded-full border-2 border-current border-r-transparent ${className}`} /> : null;
}
