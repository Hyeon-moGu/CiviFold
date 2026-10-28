// Author: HyeonMo Gu
// Created: 2026-10-27

import type { Channel, Label } from "@/lib/tools/types";

export const LABEL_TEXT: Record<Label, string> = {
  NEW: "New problem",
  DUPLICATE: "Duplicate",
  LATE_REPORT: "Late report",
  POSSIBLE_RECURRENCE: "Possible recurrence",
  ALREADY_RESOLVED: "Already fixed",
  NEEDS_INFO: "Asking the resident",
  HUMAN_REVIEW: "Needs staff review",
};

const LABEL_STYLE: Record<Label, string> = {
  NEW: "bg-zinc-100 text-zinc-800 ring-zinc-300",
  DUPLICATE: "bg-sky-50 text-sky-800 ring-sky-300",
  LATE_REPORT: "bg-indigo-50 text-indigo-800 ring-indigo-300",
  POSSIBLE_RECURRENCE: "bg-rose-50 text-rose-800 ring-rose-300",
  ALREADY_RESOLVED: "bg-emerald-50 text-emerald-800 ring-emerald-300",
  NEEDS_INFO: "bg-violet-50 text-violet-800 ring-violet-300",
  HUMAN_REVIEW: "bg-amber-50 text-amber-900 ring-amber-300",
};

export function LabelBadge({ label, size = "sm" }: { label: Label; size?: "sm" | "lg" }) {
  const pad = size === "lg" ? "px-3 py-1 text-sm" : "px-2 py-0.5 text-xs";
  return <span className={`inline-flex items-center rounded-full font-medium ring-1 ring-inset ${pad} ${LABEL_STYLE[label]}`}>{LABEL_TEXT[label]}</span>;
}

export function SyntheticBadge() {
  return <span className="rounded bg-black/70 px-1.5 py-0.5 text-[10px] font-semibold tracking-wide text-white">SYNTHETIC</span>;
}

export function UrgentBadge() {
  return <span className="inline-flex items-center rounded-full bg-red-600 px-2 py-0.5 text-xs font-semibold text-white">Urgent</span>;
}

const CHANNEL_TEXT: Record<Channel, string> = {
  photo: "Photo",
  photo_text: "Photo + text",
  text: "Text",
  voice: "Voice",
  voice_photo: "Voice + photo",
};

export function ChannelBadge({ channel }: { channel: Channel }) {
  return <span className="rounded border border-zinc-300 px-1.5 py-0.5 text-[11px] text-zinc-600">{CHANNEL_TEXT[channel]}</span>;
}
