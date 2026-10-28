// Author: HyeonMo Gu
// Created: 2026-10-27

// Guided demo scenarios. Each report step submits a dataset photo exactly as the evaluation did
// (same photo, same nearby incident photo, same category), so a deployment replays cached model
// results and spends nothing. Message steps send a sample text or recording, without a photo. Scenarios
// share the seeded world, so the hydrant stays open until the repair scenario: the replay holds in this order.
import { and, desc, eq } from "drizzle-orm";
import { messageSample } from "../dataset/messages";
import { sample } from "../dataset/static";
import { reportAnalyses, reports } from "../db/schema";
import { seedIncidentId } from "./seed";
import type { Label } from "../tools/types";
import { analyzeReport, answerReport, createReport, recordRepair, UserError, verifyReport } from "../server/reports";
import type { Runtime } from "../server/runtime";

type Step =
  | { kind: "repair"; asset: string; hours_ago: number; text: string }
  | { kind: "report"; sample: string; observed_hours_ago: number; text: string; expect: Label }
  | { kind: "message"; message: string; text: string; expect: Label; urgent?: boolean }
  // The resident answers the question the previous step's report was asked, with a dataset photo.
  | { kind: "answer"; sample: string; text: string; expect: Label }
  // Staff ask the verification agent to check the previous step's suggestion.
  | { kind: "verify"; text: string; expect: Label };

export type Scenario = { id: string; title: string; story: string; steps: Step[] };

export const SCENARIOS: Scenario[] = [
  {
    id: "duplicate",
    title: "The same hydrant from across the street",
    story:
      "A second resident reports the leaking hydrant by the BAKERY. GPS alone cannot tell; the shop sign and bike rack can. Staff can then ask the verification agent to look for evidence against the suggestion: other photos of the incident, look-alikes nearby.",
    steps: [
      { kind: "report", sample: "syn_H1_damaged_v1_across", observed_hours_ago: 0, text: "Report the hydrant from across the street", expect: "DUPLICATE" },
      { kind: "verify", text: "Ask the verification agent to check it", expect: "DUPLICATE" },
    ],
  },
  {
    id: "lookalike",
    title: "A look-alike 28 m away",
    story: "Same hydrant model, same broken cap, a few doors down. A distance rule would merge it; the surroundings say it is a different hydrant.",
    steps: [{ kind: "report", sample: "syn_H5_damaged_v1_front", observed_hours_ago: 0, text: "Report the hydrant by the LAUNDRY", expect: "NEW" }],
  },
  {
    id: "voice",
    title: "A voice message without a photo",
    story:
      "A resident says the hydrant by the bakery is leaking. Muse Voice Transcribe writes it down, but words and GPS cannot tell this hydrant from a look-alike on the same block, so the system asks for a photo. The photo settles it.",
    steps: [
      { kind: "message", message: "msg_H1_voice_en", text: "Send the voice message", expect: "NEEDS_INFO" },
      { kind: "answer", sample: "syn_H1_damaged_v1_across", text: "Answer with a photo from across the street", expect: "DUPLICATE" },
    ],
  },
  {
    id: "after-repair",
    title: "Two reports after a repair",
    story: "Staff fixed the hydrant yesterday. One report shows the old leak, seen two days ago; another shows new damage today.",
    steps: [
      { kind: "repair", asset: "H1", hours_ago: 24, text: "Record yesterday's repair" },
      { kind: "report", sample: "syn_H1_damaged_v1_sidewalk", observed_hours_ago: 48, text: "Report the old leak, seen two days ago", expect: "LATE_REPORT" },
      { kind: "report", sample: "syn_H1_damaged_v2_front", observed_hours_ago: 0, text: "Report the hydrant leaning today", expect: "POSSIBLE_RECURRENCE" },
    ],
  },
  {
    id: "dumping",
    title: "Dumped trash that was already cleared",
    story:
      "The pile by the BARBER was removed yesterday. A resident sends a photo of the clean spot from across the street. It looks fixed, but one distant photo of an empty curb is not enough to close a report as already fixed, so the system asks for another view instead of guessing.",
    steps: [
      { kind: "repair", asset: "W1", hours_ago: 24, text: "Record yesterday's cleanup" },
      { kind: "report", sample: "syn_W1_repaired_across", observed_hours_ago: 0, text: "Report the cleaned spot from across the street", expect: "NEEDS_INFO" },
    ],
  },
  {
    id: "closeup",
    title: "A close-up with nothing around it",
    story: "A resident photographs the pothole from above. Without landmarks the system asks for a wider photo instead of guessing.",
    steps: [{ kind: "report", sample: "syn_P1_damaged_v1_closeup", observed_hours_ago: 0, text: "Report a close-up of the pothole", expect: "NEEDS_INFO" }],
  },
  {
    id: "messages",
    title: "An emergency and a noise complaint",
    story: "Smoke from a street light skips matching and goes to the top of the staff queue. People yelling at night is not something a photo can match, so it goes to staff.",
    steps: [
      { kind: "message", message: "msg_S1_voice_smoke", text: "Send the smoke report (voice)", expect: "HUMAN_REVIEW", urgent: true },
      { kind: "message", message: "msg_W1_text_noise", text: "Send the noise complaint (text)", expect: "HUMAN_REVIEW" },
    ],
  },
];

const demoTag = (scenarioId: string, index: number) => `demo:${scenarioId}:${index}`;

export async function runStep(rt: Runtime, scenarioId: string, index: number) {
  const step = SCENARIOS.find((s) => s.id === scenarioId)?.steps[index];
  if (!step) throw new UserError("Unknown demo step.");
  const hoursAgo = (h: number) => new Date(Date.now() - h * 3_600_000).toISOString();
  if (step.kind === "repair") {
    await recordRepair(rt, seedIncidentId(step.asset), hoursAgo(step.hours_ago));
    return { done: step.text };
  }
  if (step.kind === "message") {
    const m = messageSample(step.message);
    if (!m) throw new UserError(`Unknown sample message ${step.message}`);
    const created = await createReport(rt, {
      photo: null,
      voice: m.kind === "voice" ? { sample_id: m.id } : null,
      lat: m.lat,
      lng: m.lng,
      observed_at: hoursAgo(0),
      observed_at_source: "assumed_submit_time",
      description: m.kind === "text" ? m.text : null,
      category_hint: m.category_hint,
      access_code: null,
    });
    await rt.database.update(reports).set({ dataset_case_id: demoTag(scenarioId, index) }).where(eq(reports.id, created.report_id));
    return { ...created, ...(await analyzeReport(rt, created.report_id)) };
  }
  if (step.kind === "verify") {
    const [checked] = await rt.database
      .select({ id: reports.id, tracking_code: reports.tracking_code })
      .from(reports)
      .where(eq(reports.dataset_case_id, demoTag(scenarioId, index - 1)));
    if (!checked) throw new UserError("Run the previous step first.");
    const [latest] = await rt.database.select({ id: reportAnalyses.id }).from(reportAnalyses).where(eq(reportAnalyses.report_id, checked.id)).orderBy(desc(reportAnalyses.id)).limit(1);
    if (!latest) throw new UserError("Run the previous step first.");
    const result = await verifyReport(rt, checked.id, latest.id);
    return { report_id: checked.id, tracking_code: checked.tracking_code, status: result.status };
  }
  if (step.kind === "answer") {
    const [asked] = await rt.database
      .select({ id: reports.id, tracking_code: reports.tracking_code })
      .from(reports)
      .where(and(eq(reports.dataset_case_id, demoTag(scenarioId, index - 1)), eq(reports.status, "needs_info")));
    if (!asked) throw new UserError("Run the previous step first.");
    await answerReport(rt, asked.id, { photo: { sample_id: step.sample } });
    return { report_id: asked.id, tracking_code: asked.tracking_code, ...(await analyzeReport(rt, asked.id)) };
  }
  const s = sample(step.sample);
  if (!s) throw new UserError(`Unknown sample ${step.sample}`);
  const created = await createReport(rt, {
    photo: { sample_id: s.id },
    voice: null,
    lat: s.lat,
    lng: s.lng,
    observed_at: hoursAgo(step.observed_hours_ago),
    observed_at_source: "user",
    description: null,
    category_hint: s.category,
    access_code: null,
  });
  await rt.database.update(reports).set({ dataset_case_id: demoTag(scenarioId, index) }).where(eq(reports.id, created.report_id));
  const analyzed = await analyzeReport(rt, created.report_id);
  return { ...created, ...analyzed };
}
