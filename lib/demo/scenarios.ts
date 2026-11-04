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
import { agentRuns, briefs, images, incidentEvents, incidents, infoRequests, reportAnalyses, reports, segmentations, staffDecisions } from "../db/schema";
import { locationOnly } from "../eval/ablations";
import { haversineM } from "../geo";
import type { Candidate, Comparison } from "../pipeline/decide";
import { seedIncidentId } from "./seed";
import type { Label } from "../tools/types";
import { briefReport } from "../server/briefs";
import { analyzeReport, ANALYSIS_USD, answerReport, createReport, recordRepair, staffDecide, UserError, verifyReport } from "../server/reports";
import { liveBudgetLeft, type Runtime } from "../server/runtime";

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
      {
        kind: "brief",
        text: "Staff ask for a case brief",
        why: "The brief says why this is not the incident 28 m away, citing the comparison, and what staff could do next. It decides nothing.",
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
        kind: "verify",
        text: "Staff ask the verification agent to check it",
        why: "A late report would be merged into a fixed incident, so the agent looks for evidence that the damage is new.",
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
      {
        kind: "brief",
        text: "Staff ask for a case brief",
        why: "The brief lays out the repair, the new damage and what staff could check before sending a crew back.",
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
      {
        kind: "report",
        sample: "syn_W1_damaged_v2_front",
        observed_hours_ago: 0,
        text: "A resident reports a new pile at the same wall today",
        why: "Same wall, a different pile after the cleanup. Expect a possible recurrence, kept apart from the cleared incident.",
        expect: "POSSIBLE_RECURRENCE",
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
  "The demo is not in the state this case expects (another visitor may have sent other cases, or staff changed an incident). Use “Reset it to the start” at the bottom of this page, then send it again.";

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

/**
 * A few lines of what the comparison model wrote about the report's photo against the incident it was compared
 * with (the suggested one, else the nearest compared), from its most detailed comparison: the model's own words,
 * with its NEW and CANDIDATE named for a visitor. A different fixture gets three lines on what tells it apart;
 * different damage on the same one gets two on the damage and one on the place.
 */
function seenBy(comparisons: Comparison[], incidentId: string | null): string[] {
  const judged = comparisons.filter((c) => c.result && !c.fallback);
  const pick = judged.filter((c) => !incidentId || c.incident_id === incidentId).sort((a, b) => b.stage - a.stage || b.result!.asset_match.confidence - a.result!.asset_match.confidence)[0];
  if (!pick?.result) return [];
  const words = (t: string) =>
    t
      .replace(/\b(?:IMAGE\s+)?N\d(?:\s*(?:\/|and|&)\s*N\d)*\b/g, "this photo")
      .replace(/\b(?:IMAGE\s+)?C\d(?:\s*(?:\/|and|&)\s*C\d)*\b/g, "the incident's photo")
      .replace(/\bNEW\b/g, "this photo")
      .replace(/^new (?=shows|has|is)/i, "this photo ")
      .replace(/^new:?\s+/i, "this photo: ")
      .replace(/^this photo: (?=.*\b(both|in both)\b)/i, "")
      .replace(/\bcandidate\b/gi, "the incident's photo");
  const { asset_match, damage } = pick.result;
  // A different fixture is told apart by its surroundings alone; different damage on the same one by the damage.
  if (asset_match.verdict === "different") return asset_match.evidence.slice(0, 3).map(words);
  const place = damage.same_damage_signature === "different" ? 1 : 2;
  // The damage lines about this report's photo first: for a recurrence they name the new damage.
  const aboutNew = (t: string) => /^(new|NEW)\b|\bthis photo\b|\bNEW\b/.test(t);
  const damageLines = [...damage.evidence.filter(aboutNew), ...damage.evidence.filter((t) => !aboutNew(t))];
  return [...asset_match.evidence.slice(0, place), ...damageLines.slice(0, 3 - place)].map(words);
}

async function analyzed(rt: Runtime, created: { report_id: string; tracking_code: string }) {
  const result = await analyzeReport(rt, created.report_id);
  if (result.error) return { ...created, error: result.error };
  const [latest] = await rt.database
    .select({
      id: reportAnalyses.id,
      final: reportAnalyses.final,
      candidates: reportAnalyses.candidates,
      comparisons: reportAnalyses.comparisons,
      usd: reportAnalyses.cost_usd,
      ms: reportAnalyses.latency_ms,
    })
    .from(reportAnalyses)
    .where(eq(reportAnalyses.report_id, created.report_id))
    .orderBy(desc(reportAnalyses.id))
    .limit(1);
  const final = latest?.final as { label: Label; incident_id: string | null } | undefined;
  const [sent] = await rt.database.select({ transcript: reports.transcript, live: reports.live }).from(reports).where(eq(reports.id, created.report_id));
  const [question] = latest ? await rt.database.select({ text: infoRequests.question }).from(infoRequests).where(eq(infoRequests.analysis_id, latest.id)).limit(1) : [];
  const cutout = (await cutoutsOf(rt, [created.report_id])).get(created.report_id);
  // The visitor who sent it sees the location-only answer beside CiviFold's, as the shared state shows it, for a
  // voice report what was heard, and the question the resident was asked.
  return {
    ...created,
    label: final?.label,
    incident_id: final?.incident_id ?? null,
    location_only: locationOnly((latest?.candidates as Candidate[] | null) ?? []),
    seen: seenBy((latest?.comparisons as Comparison[] | null) ?? [], final?.incident_id ?? null),
    ...(sent?.transcript ? { transcript: sent.transcript } : {}),
    ...(question ? { asked: question.text } : {}),
    // How this check ran: live (what the models cost and how long it took) or replayed from a recording.
    run: { live: sent?.live ?? false, usd: latest?.usd ?? 0, ms: latest?.ms ?? 0 },
    ...(cutout ? { cutout } : {}),
  };
}

/** What SAM cut out of each report's first photo: the crop, and the mask over the photo (in its pixels). */
export type Cutout = { crop: string; mask: string | null; width: number; height: number };

async function cutoutsOf(rt: Runtime, reportIds: string[]): Promise<Map<string, Cutout>> {
  if (reportIds.length === 0) return new Map();
  const photos = await rt.database
    .select({ id: images.id, report_id: images.report_id, width: images.width, height: images.height })
    .from(images)
    .where(and(inArray(images.report_id, reportIds), eq(images.kind, "original")))
    .orderBy(asc(images.id));
  if (photos.length === 0) return new Map();
  const segments = await rt.database
    .select({ image_id: segmentations.image_id, crop: segmentations.object_crop_id, mask: segmentations.mask_svg_path })
    .from(segmentations)
    .where(inArray(segmentations.image_id, photos.map((p) => p.id)));
  const out = new Map<string, Cutout>();
  for (const p of photos) {
    if (out.has(p.report_id)) continue;
    const s = segments.find((c) => c.image_id === p.id && c.crop);
    if (s?.crop) out.set(p.report_id, { crop: s.crop, mask: s.mask, width: p.width, height: p.height });
  }
  return out;
}

/** A report the visitor asked to run live does so while today's budget holds a whole analysis; else it replays. */
async function sendLive(rt: Runtime, reportId: string, live: boolean) {
  if (live && (await liveBudgetLeft(rt.database)) >= ANALYSIS_USD) await rt.database.update(reports).set({ live: true }).where(eq(reports.id, reportId));
}

// live: the visitor asked to run it live, so its report calls the models (sendLive). Otherwise, and in the play
// that seeds a reset, it replays.
export async function runStep(rt: Runtime, scenarioId: string, index: number, { live = false }: { live?: boolean } = {}) {
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
    await sendLive(rt, created.report_id, live);
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
  await sendLive(rt, created.report_id, live);
  return analyzed(rt, created);
}

const isAgent = (step: Step) => step.kind === "verify" || step.kind === "brief";

/**
 * Runs every step of every scenario on a freshly seeded world, so a visitor finds the results already there.
 * The agent steps run last, on the world every other step has left: the world a visitor's own report meets,
 * so the agents' recorded runs replay on it too (agentRecorded). Staff decisions are left out: approving a
 * suggestion is the visitor's to do, in the staff view. A step that fails is reported and the rest still run.
 */
export async function playAll(rt: Runtime): Promise<Array<{ step: string; error?: string }>> {
  const ran: Array<{ step: string; error?: string }> = [];
  const steps = SCENARIOS.flatMap((s) => s.steps.map((step, i) => ({ scenario: s.id, i, step })).filter(({ step }) => step.kind !== "decide"));
  for (const { scenario, i } of [...steps.filter((s) => !isAgent(s.step)), ...steps.filter((s) => isAgent(s.step))]) {
    const step = `${scenario}:${i}`;
    try {
      const error = ((await runStep(rt, scenario, i)) as { error?: string }).error;
      ran.push(error ? { step, error } : { step });
    } catch (err) {
      ran.push({ step, error: err instanceof Error ? err.message : String(err) });
    }
  }
  return ran;
}

// search_incidents clamps the radius here, so an agent never reads an incident farther away.
const AGENT_REACH_M = 300;
const SEEDED = /^inc_[a-z]+\d+$/;
// The seeded incidents a play repairs.
const PLAY_REPAIRS = new Set(SCENARIOS.flatMap((s) => s.steps.flatMap((step) => (step.kind === "repair" ? [seedIncidentId(step.asset)] : []))));

/**
 * Whether a replay-only deployment holds a recorded run of this agent for this report: the report was sent by a
 * demo step that one of its scenario's own agent steps acts on, its scenario's incidents are as that step expects,
 * and every other incident of the kind within the agent's reach is as a play leaves it (open, or repaired by its
 * own scenario, with nothing linked), as it was when the run was recorded at the end of a play. Any other run
 * misses the recording, at its first turn or partway through.
 */
export async function agentRecorded(
  rt: Runtime,
  report: { dataset_case_id: string | null; lat: number; lng: number },
  kind: "verify" | "brief",
): Promise<boolean> {
  const match = report.dataset_case_id?.match(/^demo:([^:]+):(\d+)$/);
  const scenario = match ? SCENARIOS.find((s) => s.id === match[1]) : undefined;
  if (!match || !scenario) return false;
  const sent = Number(match[2]);
  const at = scenario.steps.findIndex((s, i) => s.kind === kind && i > sent && ownerIndex(scenario, i) === sent);
  if (at < 0) return false;
  const ready = await checkWorld(rt, scenario, at).then(
    () => true,
    () => false,
  );
  if (!ready) return false;
  const own = new Set(scenario.world.map(seedIncidentId));
  const all = await rt.database.select({ id: incidents.id, status: incidents.status, category: incidents.category, lat: incidents.lat, lng: incidents.lng }).from(incidents);
  const kindOf = all.find((i) => own.has(i.id))?.category;
  const near = all.filter((i) => !own.has(i.id) && i.category === kindOf && haversineM(report, i) <= AGENT_REACH_M);
  if (near.some((i) => !SEEDED.test(i.id) || i.status !== (PLAY_REPAIRS.has(i.id) ? "resolved" : "open"))) return false;
  if (near.length === 0) return true;
  const events = await rt.database
    .select({ incident_id: incidentEvents.incident_id, type: incidentEvents.type })
    .from(incidentEvents)
    .where(inArray(incidentEvents.incident_id, near.map((i) => i.id)));
  return near.every((i) => {
    const types = events.filter((e) => e.incident_id === i.id).map((e) => e.type).sort();
    return types.join() === (PLAY_REPAIRS.has(i.id) ? ["created", "repair_recorded"] : ["created"]).join();
  });
}

/** The first report of a demo case that holds a stored agent run or brief, for visitors whose own send has none. */
export async function recordedAgentReport(rt: Runtime, tag: string | null): Promise<string | null> {
  if (!tag?.startsWith("demo:")) return null;
  const sent = await rt.database.select({ id: reports.id }).from(reports).where(eq(reports.dataset_case_id, tag)).orderBy(asc(reports.submitted_at));
  if (sent.length === 0) return null;
  const ids = sent.map((r) => r.id);
  const [ran, wrote] = await Promise.all([
    rt.database.select({ id: agentRuns.report_id }).from(agentRuns).where(and(inArray(agentRuns.report_id, ids), eq(agentRuns.applied, true))),
    rt.database.select({ id: briefs.report_id }).from(briefs).where(inArray(briefs.report_id, ids)),
  ]);
  const has = new Set([...ran, ...wrote].map((r) => r.id));
  return ids.find((id) => has.has(id)) ?? null;
}

export type BriefOutcome = { status: string; kept: number; dropped: number };
// What the verification agent checked on a report, counted as the staff view's verdict counts it.
export type AgentCheck = { checks: number; matching: number; ruledOut: number; against: number };

type CheckStep = { ok: boolean; tool: string; data?: unknown };
/** The latest staff-requested check, in counts a visitor reads on the demo card. */
export function agentCheckOf(steps: CheckStep[], suggested: string | null): AgentCheck {
  const out = { checks: steps.filter((s) => s.ok && s.tool !== "propose_decision").length, matching: 0, ruledOut: 0, against: 0 };
  for (const s of steps) {
    if (!s.ok || s.tool !== "compare_images") continue;
    const d = s.data as { asset_match: { verdict: string }; damage?: { same_damage_signature: string }; candidate_incident_id: string };
    const same = d.asset_match.verdict === "same";
    if (d.candidate_incident_id === suggested) {
      if (same) out.matching++;
      else out.against++;
    }
    // Another fixture, or the same fixture with a different problem, is not this report's incident.
    else if (!same || d.damage?.same_damage_signature === "different") out.ruledOut++;
    else out.against++;
  }
  return out;
}
// location_only: what the evaluation's location-only rule says for the same report (no model call), so each
// case shows the answer CiviFold replaces next to its own.
export type StepOutcome =
  | {
      report_id: string;
      tracking_code: string;
      label?: Label;
      incident_id?: string | null;
      location_only?: ReturnType<typeof locationOnly>;
      seen?: string[];
      asked?: string;
      agent?: AgentCheck;
      briefed?: number;
      cutout?: Cutout;
      run?: { live: boolean; usd: number; ms: number };
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
        .select({
          id: reportAnalyses.id,
          report_id: reportAnalyses.report_id,
          pipeline_config: reportAnalyses.pipeline_config,
          final: reportAnalyses.final,
          candidates: reportAnalyses.candidates,
          comparisons: reportAnalyses.comparisons,
        })
        .from(reportAnalyses)
        .where(inArray(reportAnalyses.report_id, ids))
        .orderBy(asc(reportAnalyses.id))
    : [];
  const resolved = new Set((await database.select({ id: incidents.id }).from(incidents).where(eq(incidents.status, "resolved"))).map((i) => i.id));
  const asked = new Map(
    (analyses.length
      ? await database.select({ analysis_id: infoRequests.analysis_id, question: infoRequests.question }).from(infoRequests).where(inArray(infoRequests.analysis_id, analyses.map((a) => a.id)))
      : []
    ).map((q) => [q.analysis_id, q.question]),
  );
  const written = ids.length
    ? await database.select({ report_id: briefs.report_id, status: briefs.status, brief: briefs.brief }).from(briefs).where(inArray(briefs.report_id, ids)).orderBy(asc(briefs.id))
    : [];
  // The latest check and brief staff asked for on each report, so a visitor back from the staff view sees them.
  const checked = ids.length
    ? await database
        .select({ report_id: agentRuns.report_id, steps: agentRuns.steps, trigger: agentRuns.trigger, analysis_id: agentRuns.analysis_id })
        .from(agentRuns)
        .where(and(inArray(agentRuns.report_id, ids), eq(agentRuns.requested_by, "staff"), eq(agentRuns.applied, true)))
        .orderBy(asc(agentRuns.id))
    : [];
  const cutouts = await cutoutsOf(rt, ids);
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
      // A verification is read from the latest report of the case that has one (the play's, until a visitor
      // verifies theirs), so the card can show what the recorded check did.
      const report =
        step.kind === "verify"
          ? tagged.find((r) => r.tag === demoTag(scenario.id, i - 1) && analyses.some((a) => a.report_id === r.id && a.pipeline_config === "C_rules+verify"))
          : tagged.find((r) => r.tag === demoTag(scenario.id, own ? i : i - 1));
      if (!report) return;
      const mine = analyses.filter((a) => a.report_id === report.id);
      const fast = mine.filter((a) => a.pipeline_config !== "C_rules+verify");
      const found = own ? fast[0] : step.kind === "answer" ? fast[1] : mine.find((a) => a.pipeline_config === "C_rules+verify");
      if (!found) return;
      const final = found.final as { label: Label; incident_id: string | null };
      // Whatever staff decided on the report, so every case card can say so, not only the one with a decide step.
      const decided = own ? decisions.filter((d) => d.report_id === report.id).at(-1) : undefined;
      const check = own || step.kind === "verify" ? checked.filter((c) => c.report_id === report.id).at(-1) : undefined;
      const brief = own ? written.filter((b) => b.report_id === report.id).at(-1) : undefined;
      const suggestedBefore = check ? (analyses.find((a) => a.id === check.analysis_id)?.final as { incident_id: string | null } | undefined)?.incident_id ?? null : null;
      out[key] = {
        report_id: report.id,
        tracking_code: report.tracking_code,
        label: final.label,
        incident_id: final.incident_id,
        ...(decided ? { decided: { action: decided.final_action, incident_id: decided.incident_id } } : {}),
        ...(check ? { agent: agentCheckOf(check.steps as CheckStep[], suggestedBefore) } : {}),
        ...(brief ? { briefed: (brief.brief as { kept?: number } | null)?.kept ?? 0 } : {}),
        ...(step.kind === "verify"
          ? {}
          : {
              location_only: locationOnly((found.candidates as Candidate[] | null) ?? []),
              seen: seenBy((found.comparisons as Comparison[] | null) ?? [], final.incident_id),
              ...(asked.has(found.id) ? { asked: asked.get(found.id) } : {}),
              ...(own && cutouts.has(report.id) ? { cutout: cutouts.get(report.id) } : {}),
            }),
      };
    });
  }
  return out;
}
