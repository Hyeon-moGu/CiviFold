// Author: HyeonMo Gu
// Created: 2026-10-28

"use client";

import { useRouter } from "next/navigation";
import { useEffect } from "react";

const EVERY_MS = 5_000;

/** Re-reads the queue while the page is in view, so new reports and finished checks appear without a reload. */
export function LiveRefresh() {
  const router = useRouter();
  useEffect(() => {
    const tick = () => {
      if (document.visibilityState === "visible") router.refresh();
    };
    const timer = setInterval(tick, EVERY_MS);
    document.addEventListener("visibilitychange", tick);
    return () => {
      clearInterval(timer);
      document.removeEventListener("visibilitychange", tick);
    };
  }, [router]);
  return (
    <span className="flex items-center gap-1.5">
      <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-emerald-400" />
      updates every {EVERY_MS / 1000} s
    </span>
  );
}
