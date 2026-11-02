// Author: HyeonMo Gu
// Created: 2026-10-27

// Building blocks of the staff console: panels, labels in the console palette, small facts.
import type { ReactNode } from "react";
import type { Label } from "@/lib/tools/types";
import { LABEL_TEXT } from "./labels";

// Four meanings, one hue each: folds onto an incident (sky), kept apart as a possible recurrence (rose), a new
// problem (neutral), waiting on a person (amber). Red is only for emergencies, violet only for agent work.
const FOLD = { text: "text-sky-300", ring: "ring-sky-500/40", dot: "bg-sky-400", bg: "bg-sky-500/10" };
const WAIT = { text: "text-amber-300", ring: "ring-amber-500/40", dot: "bg-amber-400", bg: "bg-amber-500/10" };

export const LABEL_TONE: Record<Label, { text: string; ring: string; dot: string; bg: string }> = {
  DUPLICATE: FOLD,
  LATE_REPORT: FOLD,
  ALREADY_RESOLVED: FOLD,
  NEW: { text: "text-zinc-200", ring: "ring-zinc-500/40", dot: "bg-zinc-300", bg: "bg-zinc-500/10" },
  POSSIBLE_RECURRENCE: { text: "text-rose-300", ring: "ring-rose-500/50", dot: "bg-rose-400", bg: "bg-rose-500/10" },
  NEEDS_INFO: WAIT,
  HUMAN_REVIEW: WAIT,
};

// Hex values for the map, which draws outside Tailwind.
export const LABEL_HEX: Record<Label, string> = {
  DUPLICATE: "#38bdf8",
  LATE_REPORT: "#38bdf8",
  ALREADY_RESOLVED: "#38bdf8",
  NEW: "#d4d4d8",
  POSSIBLE_RECURRENCE: "#fb7185",
  NEEDS_INFO: "#fbbf24",
  HUMAN_REVIEW: "#fbbf24",
};

export function OpsLabel({ label, size = "sm" }: { label: Label; size?: "sm" | "lg" }) {
  const t = LABEL_TONE[label];
  const pad = size === "lg" ? "px-3 py-1 text-sm" : "px-2 py-0.5 text-[11px]";
  return (
    <span className={`inline-flex items-center gap-1.5 rounded-md font-medium ring-1 ring-inset ${pad} ${t.text} ${t.ring} ${t.bg}`}>
      <span className={`h-1.5 w-1.5 rounded-full ${t.dot}`} />
      {LABEL_TEXT[label]}
    </span>
  );
}

export function UrgentTag() {
  return <span className="inline-flex items-center rounded-md bg-red-600 px-2 py-0.5 text-[11px] font-semibold tracking-wide text-white">URGENT</span>;
}

export function Panel({ title, aside, children, className = "" }: { title?: ReactNode; aside?: ReactNode; children: ReactNode; className?: string }) {
  return (
    <section className={`rounded-lg border border-ops-line bg-ops-panel ${className}`}>
      {title && (
        <header className="flex items-center gap-3 border-b border-ops-line px-4 py-2.5">
          <h2 className="text-[13px] font-medium text-ops-text">{title}</h2>
          {aside && <div className="ml-auto text-xs text-ops-dim">{aside}</div>}
        </header>
      )}
      <div className="p-4">{children}</div>
    </section>
  );
}

/** A model's confidence as staff read it: what the model said of its own verdict, not a measured accuracy. */
export const pct = (x: number) => `${Math.round(x * 100)}%`;

/**
 * A rule's reason as staff read it. The rules write for the decision table ("Same place or fixture as inc_h1
 * (0.90)"); the number is how sure the comparison model was of its verdict, not how similar the photos are.
 */
export const readable = (text: string) =>
  text
    .replace(/^All 1 nearby incidents show /, "The one nearby incident shows ")
    .replace(/Same place or fixture as (\S+) \((0(?:\.\d+)?|1(?:\.0+)?)\)/g, (_, id: string, x: string) => `Same place as ${id} in the photos (model confidence ${pct(Number(x))})`)
    .replace(/problem looks same/g, "the problem looks the same")
    .replace(/problem looks uncertain/g, "unclear if the problem is the same")
    .replace(/\((0(?:\.\d+)?|1(?:\.0+)?)\)/g, (_, x: string) => `(model confidence ${pct(Number(x))})`);

/** What one image comparison concluded: is it the same fixture or spot? */
export const VERDICT_TEXT: Record<string, string> = { same: "same", different: "not the same", uncertain: "unsure" };

export function Fact({ k, v }: { k: string; v: ReactNode }) {
  return (
    <div className="flex items-baseline justify-between gap-3 py-1 text-[13px]">
      <span className="text-ops-dim">{k}</span>
      <span className="text-right text-ops-text">{v}</span>
    </div>
  );
}
