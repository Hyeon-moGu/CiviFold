// Author: HyeonMo Gu
// Created: 2026-10-27

// Guided demo scenarios. Each report step submits a dataset photo exactly as the evaluation did
// (same photo, same nearby incident photo, same category), so a deployment replays cached model
// results and spends nothing. Message steps send a sample text or recording, without a photo. Scenarios
// share the seeded world, so each step first checks that the incidents it relies on are as the replay
// expects (open, or repaired by an earlier step of the same scenario); otherwise the visitor is asked to reset.
// A scenario that repairs an incident therefore has that incident to itself (scenarios.test.ts checks), so
// running it never puts another scenario's steps out of reach.
import { and, asc, desc, eq, inArray, like } from "drizzle-orm";
import { messageSample } from "../dataset/messages";
import { sample } from "../dataset/static";
import { briefs, incidentEvents, incidents, reportAnalyses, reports, staffDecisions } from "../db/schema";
import { locationOnly } from "../eval/ablations";
import type { Candidate } from "../pipeline/decide";
import { seedIncidentId } from "./seed";
import type { Label } from "../tools/types";
import { briefReport } from "../server/briefs";
import { analyzeReport, answerReport, createReport, recordRepair, staffDecide, UserError, verifyReport } from "../server/reports";
import type { Runtime } from "../server/runtime";

// `why` tells the visitor what is about to happen and why that answer is the right one.
type Step =
  | { kind: "repair"; asset: string; hours_ago: number; text: string; why: string }
  | { kind: "report"; sample: string; observed_hours_ago: number; text: string; why: string; expect: Label }
  | { kind: "message"; message: string; text: string; why: string; expect: Label; urgent?: boolean }
  // The resident answers the question the previous step's report was asked, with a dataset photo.
  | { kind: "answer"; sample: string; text: string; why: string; expect: Label }
  // Staff ask the verification agent to check the previous step's suggestion.
  | { kind: "verify"; text: string; why: string; expect: Label }
  // Staff ask for a case brief of the latest report sent in this scenario.
  | { kind: "brief"; text: string; why: string }
  // Staff act on the suggestion for the latest report sent in this scenario: the only step that changes a report.
  | { kind: "decide"; action: "link"; text: string; why: string };

// `world`: the seeded incidents the replay depends on, shown as already open.
export type Scenario = { id: string; title: string; story: string; world: string[]; steps: Step[] };

export const SCENARIOS: Scenario[] = [
  {
    id: "duplicate",
    title: "The same hydrant from across the street",
    story: "A second resident reports the leaking hydrant by the BAKERY. GPS alone cannot tell; the shop sign and bike rack can.",
    world: ["H1"],
    steps: [
      {
        kind: "report",
        sample: "syn_H1_damaged_v1_across",
        observed_hours_ago: 0,
        text: "A resident reports the hydrant from across the street",
        why: "The open incident is this same hydrant, seen from another angle. Expect a duplicate suggestion.",
        expect: "DUPLICATE",
      },
      {
        kind: "verify",
        text: "Staff ask the verification agent to check it",
        why: "The agent looks for evidence against the suggestion: other photos of the incident and look-alikes within 60 m.",
        expect: "DUPLICATE",
      },
      {
        kind: "brief",
        text: "Staff ask for a case brief",
        why: "The brief agent reads the pipeline's facts, the incident's history and what is open nearby, and writes the brief staff read before deciding. Every item cites a tool result or a fact; the rest is deleted. It decides nothing.",
      },
      {
        kind: "decide",
        action: "link",
        text: "Staff approve the suggestion",
        why: "A member of staff links the report to the open incident. Only this click changes anything: the suggestion, the check and the brief were all advice. The resident's page now says decided.",
      },
    ],
  },
  {
    id: "lookalike",
    title: "A look-alike 28 m away",
    story: "Same hydrant model, same broken cap, a few doors down. A distance rule would merge it.",
    world: ["H1"],
    steps: [
      {
        kind: "report",
        sample: "syn_H5_damaged_v1_front",
        observed_hours_ago: 0,
        text: "A resident reports the hydrant by the LAUNDRY",
        why: "The open incident is a different hydrant 28 m away. The surroundings do not match, so expect a new incident.",
        expect: "NEW",
      },
    ],
  },
  {
    id: "voice",
    title: "A voice message without a photo",
    story: "A resident says the hydrant by the bakery is leaking. Muse Voice Transcribe writes it down.",
    world: ["H1"],
    steps: [
      {
        kind: "message",
        message: "msg_H1_voice_en",
        text: "A resident sends a voice message",
        why: "Words and GPS cannot tell this hydrant from a look-alike on the same block, so expect a request for a photo.",
        expect: "NEEDS_INFO",
      },
      {
        kind: "answer",
        sample: "syn_H1_damaged_v1_across",
        text: "The resident answers with a photo from across the street",
        why: "The photo shows the hydrant of the open incident. Expect a duplicate suggestion.",
        expect: "DUPLICATE",
      },
    ],
  },
  {
    id: "after-repair",
    title: "Two reports after a repair",
    story: "Staff fixed the hydrant by the FLOWERS shop yesterday. One report shows the old leak, seen two days ago; another shows new damage today.",
    world: ["H2"],
    steps: [
      { kind: "repair", asset: "H2", hours_ago: 24, text: "Staff record yesterday's repair", why: "The open incident is marked fixed, as of 24 hours ago." },
      {
        kind: "report",
        sample: "syn_H2_damaged_v1_sidewalk",
        observed_hours_ago: 48,
        text: "A resident reports the old leak, seen two days ago",
        why: "Same hydrant and damage, seen before the repair. Expect a late report, not a new problem.",
        expect: "LATE_REPORT",
      },
      {
        kind: "report",
        sample: "syn_H2_damaged_v2_front",
        observed_hours_ago: 0,
        text: "A resident reports the hydrant tagged and cracked today",
        why: "Same hydrant, new damage after the repair. Expect a possible recurrence, kept apart from the fixed incident.",
        expect: "POSSIBLE_RECURRENCE",
      },
    ],
  },
  {
    id: "dumping",
    title: "Dumped trash that was already cleared",
    story: "The pile by the BARBER was removed yesterday. A resident sends a photo of the clean spot from across the street.",
    world: ["W1"],
    steps: [
      { kind: "repair", asset: "W1", hours_ago: 24, text: "Staff record yesterday's cleanup", why: "The open incident is marked cleared, as of 24 hours ago." },
      {
        kind: "report",
        sample: "syn_W1_repaired_across",
        observed_hours_ago: 0,
        text: "A resident reports the cleaned spot from across the street",
        why: "It looks fixed, but one distant photo of an empty curb is not enough to say so. Expect a request for another view.",
        expect: "NEEDS_INFO",
      },
      {
        kind: "brief",
        text: "Staff ask for a case brief",
        why: "A report that was asked for another view is where a brief earns its keep: it says what the one distant photo settles, what it does not, and what to ask for. Every item cites a fact or a tool result; the rest is deleted.",
      },
    ],
  },
  {
    id: "closeup",
    title: "A close-up with nothing around it",
    story: "A resident photographs the pothole from above.",
    world: ["P1"],
    steps: [
      {
        kind: "report",
        sample: "syn_P1_damaged_v1_closeup",
        observed_hours_ago: 0,
        text: "A resident reports a close-up of the pothole",
        why: "No landmarks in the photo, so it cannot be tied to the open incident. Expect a request for a wider photo.",
        expect: "NEEDS_INFO",
      },
    ],
  },
  {
    id: "messages",
    title: "An emergency and a noise complaint",
    story: "Two messages without a photo: one about smoke, one about people yelling at night.",
    world: [],
    steps: [
      {
        kind: "message",
        message: "msg_S1_voice_smoke",
        text: "A resident reports smoke from a street light (voice)",
        why: "A possible emergency skips matching and goes to the top of the staff queue.",
        expect: "HUMAN_REVIEW",
        urgent: true,
      },
      {
        kind: "message",
        message: "msg_W1_text_noise",
        text: "A resident complains about noise (text)",
        why: "A photo cannot match people's behavior, so it goes to staff.",
        expect: "HUMAN_REVIEW",
      },
    ],
  },
];

const demoTag = (scenarioId: string, index: number) => `demo:${scenarioId}:${index}`;

const RESET =
  "The demo is not in the state this step expects (another visitor may have run other scenarios, or staff changed an incident). Press Reset the demo, then run the steps in order.";

/** Each incident the scenario relies on is open, or repaired once by an earlier step of the same scenario, and nothing else has happened to it. */
async function checkWorld(rt: Runtime, scenario: Scenario, index: number) {
  // A linked report leaves its incident open with the representative photo first, the only incident photo the
  // fast path compares, so report steps still replay as recorded. The agents read every photo and event of an
  // incident, so before their steps a link is a change like any other.
  const kind = scenario.steps[index]!.kind;
  const agent = kind === "verify" || kind === "brief";
  for (const asset of scenario.world) {
    const id = seedIncidentId(asset);
    const repaired = scenario.steps.slice(0, index).some((s) => s.kind === "repair" && s.asset === asset);
    const [incident] = await rt.database.select({ status: incidents.status }).from(incidents).where(eq(incidents.id, id));
    const events = await rt.database.select({ type: incidentEvents.type }).from(incidentEvents).where(eq(incidentEvents.incident_id, id));
    const types = events
      .map((e) => e.type)
      .filter((t) => agent || t !== "report_linked")
      .sort();
    const expected = repaired ? ["created", "repair_recorded"] : ["created"];
    if (!incident || incident.status !== (repaired ? "resolved" : "open") || types.join() !== expected.join()) throw new UserError(RESET);
  }
}

async function analyzed(rt: Runtime, created: { report_id: string; tracking_code: string }) {
  const result = await analyzeReport(rt, created.report_id);
  if (result.error) return { ...created, error: result.error };
  const [latest] = await rt.database
    .select({ final: reportAnalyses.final })
    .from(reportAnalyses)
    .where(eq(reportAnalyses.report_id, created.report_id))
    .orderBy(desc(reportAnalyses.id))
    .limit(1);
  return { ...created, label: (latest?.final as { label: Label } | undefined)?.label };
}

export async function runStep(rt: Runtime, scenarioId: string, index: number) {
  const scenario = SCENARIOS.find((s) => s.id === scenarioId);
  const step = scenario?.steps[index];
  if (!scenario || !step) throw new UserError("Unknown demo step.");
  await checkWorld(rt, scenario, index);
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
    return analyzed(rt, created);
  }
  if (step.kind === "verify") {
    const [checked] = await rt.database
      .select({ id: reports.id, tracking_code: reports.tracking_code })
      .from(reports)
      .where(eq(reports.dataset_case_id, demoTag(scenarioId, index - 1)))
      .orderBy(desc(reports.submitted_at))
      .limit(1);
    if (!checked) throw new UserError("Run the previous step first.");
    const [latest] = await rt.database.select({ id: reportAnalyses.id }).from(reportAnalyses).where(eq(reportAnalyses.report_id, checked.id)).orderBy(desc(reportAnalyses.id)).limit(1);
    if (!latest) throw new UserError("Run the previous step first.");
    const result = await verifyReport(rt, checked.id, latest.id);
    const out = { report_id: checked.id, tracking_code: checked.tracking_code };
    if (result.status === "applied") return { ...out, label: result.label };
    if (result.status === "not_started") return { ...out, error: result.message };
    if (result.status === "facts_changed") return { ...out, error: RESET };
    return { ...out, error: "Another check or a staff decision took over this report." };
  }
  if (step.kind === "brief") {
    const { report, latest } = await owned(rt, scenario, index);
    const result = await briefReport(rt, report.id, latest.id);
    const out = { report_id: report.id, tracking_code: report.tracking_code };
    if (result.status === "not_started") return { ...out, error: result.message };
    return { ...out, brief: briefOutcome(result.run) };
  }
  if (step.kind === "decide") {
    const { report, latest } = await owned(rt, scenario, index);
    const incidentId = (latest.final as { incident_id: string | null }).incident_id;
    if (!incidentId) throw new UserError("The suggestion names no incident to link to. Run the earlier steps first.");
    await staffDecide(rt, report.id, step.action, incidentId, undefined, { analysis_id: latest.id, facts_changed_seen: false });
    return { report_id: report.id, tracking_code: report.tracking_code, decided: { action: step.action, incident_id: incidentId } };
  }
  if (step.kind === "answer") {
    const [asked] = await rt.database
      .select({ id: reports.id, tracking_code: reports.tracking_code })
      .from(reports)
      .where(and(eq(reports.dataset_case_id, demoTag(scenarioId, index - 1)), eq(reports.status, "needs_info")))
      .orderBy(desc(reports.submitted_at))
      .limit(1);
    if (!asked) throw new UserError("Run the previous step first.");
    await answerReport(rt, asked.id, { photo: { sample_id: step.sample } });
    return analyzed(rt, { report_id: asked.id, tracking_code: asked.tracking_code });
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
  return analyzed(rt, created);
}

/**
 * Runs every step of every scenario, in order, on a freshly seeded world, so a visitor finds the results
 * already there. Staff decisions are left out: approving a suggestion is the visitor's to do, in the staff
 * view. A step that fails is reported and the rest still run.
 */
export async function playAll(rt: Runtime): Promise<Array<{ step: string; error?: string }>> {
  const ran: Array<{ step: string; error?: string }> = [];
  for (const scenario of SCENARIOS) {
    for (let i = 0; i < scenario.steps.length; i++) {
      if (scenario.steps[i]!.kind === "decide") continue;
      const step = `${scenario.id}:${i}`;
      try {
        const error = ((await runStep(rt, scenario.id, i)) as { error?: string }).error;
        ran.push(error ? { step, error } : { step });
      } catch (err) {
        ran.push({ step, error: err instanceof Error ? err.message : String(err) });
      }
    }
  }
  return ran;
}

export type BriefOutcome = { status: string; kept: number; dropped: number };
// location_only: what the evaluation's location-only rule says for the same report (no model call), so each
// case shows the answer CiviFold replaces next to its own.
export type StepOutcome =
  | {
      report_id: string;
      tracking_code: string;
      label?: Label;
      incident_id?: string | null;
      location_only?: ReturnType<typeof locationOnly>;
      brief?: BriefOutcome;
      decided?: { action: string; incident_id: string | null };
    }
  | { done: string };

const briefOutcome = (run: { status: string; brief: { kept: number; dropped: number } | null }): BriefOutcome => ({ status: run.status, kept: run.brief?.kept ?? 0, dropped: run.brief?.dropped ?? 0 });

// The latest step before `index` that sent a report: a brief or a staff decision (like a verification) acts on that report.
function ownerIndex(scenario: Scenario, index: number): number {
  for (let i = index - 1; i >= 0; i--) if (scenario.steps[i]!.kind === "report" || scenario.steps[i]!.kind === "message") return i;
  throw new UserError("Run the previous step first.");
}

async function owned(rt: Runtime, scenario: Scenario, index: number) {
  const [report] = await rt.database
    .select({ id: reports.id, tracking_code: reports.tracking_code })
    .from(reports)
    .where(eq(reports.dataset_case_id, demoTag(scenario.id, ownerIndex(scenario, index))))
    .orderBy(desc(reports.submitted_at))
    .limit(1);
  if (!report) throw new UserError("Run the previous step first.");
  const [latest] = await rt.database
    .select({ id: reportAnalyses.id, final: reportAnalyses.final })
    .from(reportAnalyses)
    .where(eq(reportAnalyses.report_id, report.id))
    .orderBy(desc(reportAnalyses.id))
    .limit(1);
  if (!latest) throw new UserError("Run the previous step first.");
  return { report, latest };
}

/**
 * What every step has already done, read back from the shared world: the demo tags its reports
 * (dataset_case_id), the scenarios' repairs resolve their incidents and staff decisions are kept per report.
 * A visitor's progress survives a page change, and steps another visitor ran show their result instead of
 * failing the world check.
 */
export async function demoState(rt: Runtime): Promise<Record<string, StepOutcome>> {
  const { database } = rt;
  const tagged = await database
    .select({ id: reports.id, tracking_code: reports.tracking_code, tag: reports.dataset_case_id })
    .from(reports)
    .where(like(reports.dataset_case_id, "demo:%"))
    .orderBy(desc(reports.submitted_at), desc(reports.id));
  const ids = tagged.map((r) => r.id);
  const analyses = ids.length
    ? await database
        .select({ report_id: reportAnalyses.report_id, pipeline_config: reportAnalyses.pipeline_config, final: reportAnalyses.final, candidates: reportAnalyses.candidates })
        .from(reportAnalyses)
        .where(inArray(reportAnalyses.report_id, ids))
        .orderBy(asc(reportAnalyses.id))
    : [];
  const resolved = new Set((await database.select({ id: incidents.id }).from(incidents).where(eq(incidents.status, "resolved"))).map((i) => i.id));
  const written = ids.length
    ? await database.select({ report_id: briefs.report_id, status: briefs.status, brief: briefs.brief }).from(briefs).where(inArray(briefs.report_id, ids)).orderBy(asc(briefs.id))
    : [];
  const decisions = ids.length
    ? await database
        .select({ report_id: staffDecisions.report_id, final_action: staffDecisions.final_action, incident_id: staffDecisions.incident_id })
        .from(staffDecisions)
        .where(inArray(staffDecisions.report_id, ids))
        .orderBy(asc(staffDecisions.id))
    : [];
  const out: Record<string, StepOutcome> = {};
  for (const scenario of SCENARIOS) {
    scenario.steps.forEach((step, i) => {
      const key = `${scenario.id}:${i}`;
      if (step.kind === "repair") {
        if (resolved.has(seedIncidentId(step.asset))) out[key] = { done: step.text };
        return;
      }
      if (step.kind === "brief") {
        const report = tagged.find((r) => r.tag === demoTag(scenario.id, ownerIndex(scenario, i)));
        const last = report && written.filter((b) => b.report_id === report.id).at(-1);
        if (report && last) out[key] = { report_id: report.id, tracking_code: report.tracking_code, brief: briefOutcome({ status: last.status, brief: last.brief as BriefOutcome | null }) };
        return;
      }
      if (step.kind === "decide") {
        const report = tagged.find((r) => r.tag === demoTag(scenario.id, ownerIndex(scenario, i)));
        const last = report && decisions.filter((d) => d.report_id === report.id).at(-1);
        if (report && last) out[key] = { report_id: report.id, tracking_code: report.tracking_code, decided: { action: last.final_action, incident_id: last.incident_id } };
        return;
      }
      // An answer and a verification act on the previous step's report, each adding an analysis of its own.
      const own = step.kind === "report" || step.kind === "message";
      const report = tagged.find((r) => r.tag === demoTag(scenario.id, own ? i : i - 1));
      if (!report) return;
      const mine = analyses.filter((a) => a.report_id === report.id);
      const fast = mine.filter((a) => a.pipeline_config !== "C_rules+verify");
      const found = own ? fast[0] : step.kind === "answer" ? fast[1] : mine.find((a) => a.pipeline_config === "C_rules+verify");
      if (!found) return;
      const final = found.final as { label: Label; incident_id: string | null };
      out[key] = {
        report_id: report.id,
        tracking_code: report.tracking_code,
        label: final.label,
        incident_id: final.incident_id,
        ...(step.kind === "verify" ? {} : { location_only: locationOnly((found.candidates as Candidate[] | null) ?? []) }),
      };
    });
  }
  return out;
}
