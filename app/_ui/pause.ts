// Author: HyeonMo Gu
// Created: 2026-11-04

// A request refused for its pace (429) holds back, across the page, the buttons that send that kind of request
// until the wait the server gave ends, so a visitor is not invited to click into the same refusal.
import { useSyncExternalStore } from "react";

export type PauseKind = "reset" | "report" | "live" | "replay" | "staff";

const until: Partial<Record<PauseKind, number>> = {};
const listeners = new Set<() => void>();
const notify = () => listeners.forEach((l) => l());

/** Reads a response: a 429 pauses `kind` for its Retry-After (a minute when it gives none). */
export function pauseFrom(res: Response, kind: PauseKind): void {
  if (res.status !== 429) return;
  const s = Number(res.headers.get("Retry-After"));
  const end = Date.now() + (Number.isFinite(s) && s > 0 ? s : 60) * 1000;
  until[kind] = end;
  notify();
  setTimeout(notify, end - Date.now() + 50);
}

export function usePaused(kind: PauseKind): boolean {
  return useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    () => (until[kind] ?? 0) > Date.now(),
    () => false,
  );
}
