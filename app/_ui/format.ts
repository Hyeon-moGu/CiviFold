// Author: HyeonMo Gu
// Created: 2026-10-27

import { DEMO_TIME_ZONE } from "@/lib/dataset/place";

const timeZone = DEMO_TIME_ZONE;
const FORMAT = new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit", timeZone });
const SECONDS = new Intl.DateTimeFormat("en-US", { hour: "numeric", minute: "2-digit", second: "2-digit", timeZone });
const DAY = new Intl.DateTimeFormat("en-CA", { timeZone });

export const when = (t: string | null | undefined) => (t ? FORMAT.format(new Date(t)) : "n/a");

/** What model calls cost: nothing means every call was replayed from a recorded run, which "$0.000" would hide. */
export const cost = (usd: number) => (usd > 0 ? `$${usd.toFixed(3)}` : "replayed");

/** Today's reports to the second (reports minutes apart still read apart); older ones with their date. */
export function clock(t: string, now = Date.now()): string {
  const d = new Date(t);
  return DAY.format(d) === DAY.format(now) ? SECONDS.format(d) : FORMAT.format(d);
}

export function ago(t: string, now = Date.now()): string {
  const min = Math.round((now - new Date(t).getTime()) / 60_000);
  if (Math.abs(min) < 1) return "just now";
  if (min > 0 && min < 60) return `${min} min ago`;
  const h = Math.round(min / 60);
  if (Math.abs(h) < 48) return h > 0 ? `${h}h ago` : `in ${-h}h`;
  const d = Math.round(h / 24);
  return d > 0 ? `${d}d ago` : `in ${-d}d`;
}
