// Author: HyeonMo Gu
// Created: 2026-10-27

// What a resident may see about their own report: status in plain words, the open question,
// their photos. No model evidence, candidate incidents or other residents' photos.
import { samples, type Sample } from "../dataset/static";
import { haversineM } from "../geo";
import type { Channel, Label, RequestItem } from "../tools/types";
import { wordsNotRead, type reportDetail, type WordsUnread } from "./reports";

type Detail = NonNullable<Awaited<ReturnType<typeof reportDetail>>>;

const SUGGESTION_TEXT: Record<Label, string> = {
  DUPLICATE: "This looks like a problem someone already reported. Staff will confirm and keep you posted on that case.",
  LATE_REPORT: "This looks like a problem that was already fixed after your photo was taken. Staff will confirm.",
  ALREADY_RESOLVED: "This looks fixed already. Staff will confirm.",
  NEW: "This looks like a new problem. Staff will review it.",
  POSSIBLE_RECURRENCE: "This may be the same problem coming back after a repair. Staff will review it first.",
  HUMAN_REVIEW: "A member of staff will look at your report.",
  NEEDS_INFO: "We need one more thing from you.",
};

const URGENT_TEXT = "If anyone is in danger, call 911 now. We sent your report to staff as urgent.";

const WORDS_UNREAD_TEXT: Record<WordsUnread, string> = {
  no_recording: "Staff will read your message themselves. The automatic check did not: the public demo has no recorded reading of it.",
  budget: "Staff will read your message themselves. The automatic check did not: live model calls are paused for today.",
};

const STATUS_TEXT: Record<string, string> = {
  received: "Received. We are checking your report.",
  analyzing: "We are checking your report.",
  needs_info: "We need one more thing from you.",
  answered: "Thanks. We are checking your answer.",
  linked: "Staff linked your report to an existing case.",
  new_incident: "Staff opened a case from your report.",
  dismissed: "Staff closed your report without opening a case.",
  unavailable: "The public demo has no recorded check for this report. Staff will look at it themselves.",
  failed: "The automatic check failed. A member of staff will look at your report.",
};

export type ResidentView = {
  report_id: string;
  tracking_code: string;
  status: string;
  status_text: string;
  submitted_at: string;
  observed_at: string;
  channel: Channel;
  urgent: boolean;
  description: string | null;
  transcript: string | null;
  has_audio: boolean;
  note: string | null; // when the automatic check did not read the message
  photos: string[];
  synthetic_photos: string[]; // the photos among them that are synthetic (dataset samples), badged as such
  question: { question: string; requested_items: RequestItem[] } | null;
  // Demo only: the other dataset photos of the same place, so a visitor can answer like a resident would.
  suggested_samples: Sample[];
  live: boolean; // sent with the access code: an answer with the resident's own photo needs no code again
};

export function residentView(d: Detail): ResidentView {
  const final = d.analysis?.final as { label: Label } | undefined;
  const pending = [...d.questions].reverse().find((q) => q.status === "pending");
  const status = d.report.status;
  const asset = d.photos.find((p) => p.dataset_image_id)?.dataset_image_id?.split("_")[1] ?? nearestAsset(d.report);
  const urgent = d.report.urgent;
  const unread = wordsNotRead(d.analysis?.errors);
  return {
    report_id: d.report.id,
    tracking_code: d.report.tracking_code,
    status,
    status_text: urgent ? URGENT_TEXT : status === "under_review" && final ? SUGGESTION_TEXT[final.label] : (STATUS_TEXT[status] ?? "Received."),
    submitted_at: new Date(d.report.submitted_at).toISOString(),
    observed_at: new Date(d.report.observed_at).toISOString(),
    channel: d.report.channel as Channel,
    urgent,
    description: d.report.description,
    transcript: d.report.transcript,
    has_audio: d.report.audio_path !== null,
    note: unread ? WORDS_UNREAD_TEXT[unread] : null,
    photos: d.photos.map((p) => p.id),
    synthetic_photos: d.photos.filter((p) => p.is_synthetic).map((p) => p.id),
    question: pending ? { question: pending.question, requested_items: pending.requested_items as RequestItem[] } : null,
    suggested_samples: pending && asset ? samples().filter((s) => s.asset_id === asset) : [],
    live: d.report.live,
  };
}

// Demo only: a report sent without a photo is answered with photos of the dataset place it was sent from.
const NEAR_M = 25;
function nearestAsset(at: { lat: number; lng: number }): string | undefined {
  const near = samples()
    .map((s) => ({ asset: s.asset_id, m: haversineM(at, s) }))
    .filter((s) => s.m <= NEAR_M)
    .sort((a, b) => a.m - b.m);
  return near[0]?.asset;
}
