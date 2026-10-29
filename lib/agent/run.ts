// Author: HyeonMo Gu
// Created: 2026-10-27

// The verification agent: Muse Spark picks among the same tools the fast path uses to look for evidence
// against a suggestion that would bury a problem if wrong, and ends with a proposal the guardrail checks.
// Every call is recorded; a run that fails, overruns its budget or ends without a terminal tool
// leaves the report to staff.
import type { z } from "zod";
import { cacheKey } from "../meta/cache";
import { CacheMissError, LiveBudgetError, metered } from "../meta/call";
import { functionCalls, sparkRespond } from "../meta/responses";
import { decideInputOf, type Analysis, type ReportInput } from "../pipeline/analyze";
import { AGENT_LIMITS, SEARCH_CONFIG } from "../pipeline/config";
import type { GuardResult, GuardStep, Proposal } from "../pipeline/guard";
import { loadPrompt } from "../prompts";
import type { AskResidentIn } from "../tools/ask-resident";
import { compareImages } from "../tools/compare-images";
import { getIncidentTimeline } from "../tools/get-incident-timeline";
import { dataUrl } from "../tools/images";
import { toFunctionTool } from "../tools/json-schema";
import { proposeDecision } from "../tools/propose-decision";
import { searchIncidents } from "../tools/search-incidents";
import { segmentObject } from "../tools/segment-object";
import type { Label, MissingItem, Tool, ToolContext } from "../tools/types";
import { Aliases } from "./aliases";

// The tools differ in their zod types; the loop only needs their common shape.
type AnyTool = Tool<z.ZodType, z.ZodType>;
// Questions to the resident come from the rules (R5, R2w, R7r and the rest), so the agent is not offered ask_resident.
const TOOLS = [searchIncidents, getIncidentTimeline, segmentObject, compareImages, proposeDecision] as unknown as AnyTool[];
const TERMINAL = TOOLS.filter((t) => t.terminal);

export type AgentStep = GuardStep & { step: number; error: string | null; ms: number; usd: number };

export type AgentRun = {
  trigger: { label: Label; rule_id: string };
  status: "proposed" | "blocked" | "asked_resident" | "failed" | "budget_exceeded";
  steps: AgentStep[];
  proposal: Proposal | null;
  guard: GuardResult | null;
  question: z.infer<typeof AskResidentIn> | null;
  final: { label: Label; incident_id: string | null; missing_info: MissingItem[] };
  error: string | null; // why a failed run stopped
  cost_usd: number;
  latency_ms: number;
};

type Limits = typeof AGENT_LIMITS;

// onStep sees each tool call as it finishes, so a screen can show the run while it is under way.
export async function investigate(
  report: ReportInput,
  analysis: Analysis,
  ctx: ToolContext,
  limits: Limits = AGENT_LIMITS,
  onStep?: (step: AgentStep) => void,
): Promise<AgentRun> {
  const start = Date.now();
  const steps: AgentStep[] = [];
  const runCtx: ToolContext = { ...ctx, investigation: { steps, base: decideInputOf(report, analysis) }, signal: AbortSignal.timeout(limits.max_ms), compareModel: limits.compare_model };
  const prompt = await loadPrompt("agent");
  const photo = await ctx.images.get(report.image_id);
  const known = await preload(report, analysis, ctx);
  const names = new Aliases();
  names.collect({ report, analysis: { decision: analysis.decision, candidates: analysis.candidates, comparisons: analysis.comparisons }, known });
  const input: unknown[] = [
    { role: "system", content: prompt.text.replace("{max_steps}", String(limits.max_steps)) },
    {
      role: "user",
      content: [
        { type: "input_text", text: names.mask(contextMessage(report, analysis, known)) },
        { type: "input_text", text: "IMAGE R1 — the report's main photo" },
        { type: "input_image", image_url: dataUrl(await ctx.images.bytes(report.image_id), photo?.mime ?? "image/webp") },
      ],
    },
  ];

  let usd = 0;
  let status: AgentRun["status"] | null = null;
  let proposal: Proposal | null = null;
  let guardResult: GuardResult | null = null;
  let question: AgentRun["question"] = null;
  let error: string | null = null;
  const seen = new Map<string, AgentStep>();
  const deadline = start + limits.max_ms;
  let turns = 0;
  // Checked before every model turn and before every tool call, so nothing (a proposal included) runs past a
  // limit. Cost is known only after a call, so a call starts only when a typical one still fits.
  const exhausted = () => steps.length >= limits.max_steps || usd + limits.call_usd_estimate > limits.max_usd || Date.now() >= deadline;
  // Near any limit (the last step, little time or money left) only the terminal tools are offered, since
  // tool_choice cannot force a call, so a run ends with a proposal instead of being cut off.
  let wrapUp = false; // set when the model stopped calling tools: it gets the closing turns to propose
  const closing = () => wrapUp || steps.length >= limits.max_steps - 1 || deadline - Date.now() < limits.closing_ms || usd + 2 * limits.call_usd_estimate > limits.max_usd;
  const closingNote = (await loadPrompt("agent_closing")).text;
  let closingTurns = 0;

  try {
    turns: while (status === null) {
      if (exhausted()) {
        status = "budget_exceeded";
        break;
      }
      const offered = closing() ? TERMINAL : TOOLS;
      if (offered === TERMINAL) {
        // One reminder and two chances: a model that still will not propose ends the run.
        if (closingTurns === 0) input.push({ role: "user", content: [{ type: "input_text", text: closingNote }] });
        if (closingTurns >= 2) {
          status = "budget_exceeded";
          break;
        }
        closingTurns += 1;
      }
      const signal = AbortSignal.timeout(Math.max(1, deadline - Date.now()));
      // A turn that fails after paid attempts still cost them: metered counts it either way.
      const turn = await metered(() =>
        beforeDeadline(sparkRespond({ input, tools: offered.map(toFunctionTool), mode: ctx.mode, signal }), deadline).then(
          (response) => ({ ok: true as const, response }),
          (err: unknown) => ({ ok: false as const, err }),
        ),
      );
      usd += turn.usd;
      if (!turn.result.ok) throw turn.result.err;
      turns += 1;
      const calls = functionCalls(turn.result.response.output);
      input.push(...turn.result.response.output);
      if (calls.length === 0) {
        if (!wrapUp && closingTurns === 0) {
          wrapUp = true;
          continue;
        }
        status = "failed";
        error = "The model answered without calling a tool.";
        break;
      }

      for (const call of calls) {
        if (exhausted()) {
          status = "budget_exceeded";
          break turns;
        }
        // Near a limit the last step is kept for a proposal: other calls (several can come in one turn, or one
        // the model was not offered) are answered without running or counting as a step.
        if (closing() && !TERMINAL.some((t) => t.name === call.name)) {
          const error = "Not run: only propose_decision is available now.";
          input.push({ type: "function_call_output", call_id: call.call_id, output: JSON.stringify({ ok: false, error, steps_left: limits.max_steps - steps.length }) });
          continue;
        }
        const { step, halt } = await runStep(call.name, names.unmask(call.arguments), steps.length + 1, runCtx, seen, offered, deadline);
        usd += step.usd;
        steps.push(step);
        // A screen that went away (a closed stream) must not decide how the run ends.
        try {
          onStep?.(step);
        } catch (err) {
          console.error("step listener failed", err);
        }
        if (halt) {
          // The tool could not finish for want of a cached reply or budget: its step and cost are on record.
          status = halt;
          error = step.error;
          break turns;
        }
        const steps_left = limits.max_steps - steps.length;
        names.collect(step.data);
        input.push({ type: "function_call_output", call_id: call.call_id, output: names.mask(JSON.stringify({ ref: step.ref, ok: step.ok, error: step.error, data: step.data, steps_left })) });
        if (step.ok && step.tool === "propose_decision") {
          proposal = step.args as Proposal;
          guardResult = step.data as GuardResult;
          status = guardResult.passed ? "proposed" : "blocked";
        } else if (step.ok && step.tool === "ask_resident") {
          question = step.args as AgentRun["question"];
          status = "asked_resident";
        }
        if (status !== null) break turns;
      }
    }
  } catch (err) {
    // Before any turn, a replay-only deployment or a spent daily budget is the caller's to handle: there
    // is nothing to record. Later, the run ends here with the steps (and their cost) so far on record.
    if ((err instanceof CacheMissError || err instanceof LiveBudgetError) && turns === 0) throw err;
    status = err instanceof LiveBudgetError || Date.now() >= deadline ? "budget_exceeded" : "failed";
    error = (err instanceof Error ? err.message : String(err)).slice(0, 500);
  }

  const final: AgentRun["final"] =
    status === "proposed" || status === "blocked"
      ? { label: guardResult!.final_label, incident_id: guardResult!.final_incident_id, missing_info: [] }
      : status === "asked_resident"
        ? { label: "NEEDS_INFO", incident_id: null, missing_info: question!.requested_items }
        : { label: "HUMAN_REVIEW", incident_id: null, missing_info: [] };
  return {
    trigger: { label: analysis.decision.label, rule_id: analysis.decision.rule_id },
    status: status!,
    steps,
    proposal,
    guard: guardResult,
    question,
    final,
    error,
    cost_usd: usd,
    latency_ms: Date.now() - start,
  };
}

class DeadlineError extends Error {}

/** Stops waiting at the deadline. The call itself may still finish; its cost still reaches the daily total. */
async function beforeDeadline<T>(work: Promise<T>, deadline: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new DeadlineError("The run reached its time limit")), Math.max(0, deadline - Date.now()));
  });
  try {
    return await Promise.race([work, late]);
  } finally {
    clearTimeout(timer);
  }
}

async function runStep(
  calledName: string,
  rawArgs: string,
  n: number,
  ctx: ToolContext,
  seen: Map<string, AgentStep>,
  offered: AnyTool[],
  deadline: number,
): Promise<{ step: AgentStep; halt: "budget_exceeded" | "failed" | null }> {
  // The model sometimes namespaces a tool ("default.search_incidents"); the tool is the last segment.
  const name = calledName.slice(calledName.lastIndexOf(".") + 1);
  const t0 = Date.now();
  const ref = `step_${n}`;
  const record = (fields: Pick<AgentStep, "ok" | "error" | "data" | "args"> & { usd?: number }): AgentStep => ({
    ref,
    step: n,
    tool: name,
    ms: Date.now() - t0,
    usd: 0,
    ...fields,
  });
  const step = (fields: Parameters<typeof record>[0]) => ({ step: record(fields), halt: null });
  const tool = offered.find((t) => t.name === name);
  if (!tool) return step({ ok: false, error: `${name} is not available now; offered: ${offered.map((t) => t.name).join(", ")}`, data: null, args: rawArgs });
  let args: unknown;
  try {
    args = JSON.parse(rawArgs);
  } catch {
    return step({ ok: false, error: "arguments are not valid JSON", data: null, args: rawArgs });
  }
  const parsed = tool.input.safeParse(args);
  if (!parsed.success) return step({ ok: false, error: parsed.error.message.slice(0, 500), data: null, args });

  // A comparison may be repeated after either image was segmented again: the crops it compares changed.
  const pair = name === "compare_images" ? [(parsed.data as { new_image_id: string }).new_image_id, (parsed.data as { candidate_image_id: string }).candidate_image_id] : [];
  const resegmented = (ctx.investigation?.steps ?? []).filter((s) => s.ok && s.tool === "segment_object" && pair.includes((s.args as { image_id: string }).image_id)).length;
  const key = cacheKey({ name, args: parsed.data, resegmented });
  const earlier = seen.get(key);
  if (earlier) return step({ ok: false, error: `duplicate_call: same as ${earlier.ref}`, data: earlier.data, args: parsed.data });
  // A tool that fails after a paid call still cost that call: metered counts it either way.
  const { result: outcome, usd } = await metered(() =>
    beforeDeadline(tool.run(parsed.data, ctx), deadline).then(
      (data) => ({ ok: true as const, data }),
      (err: unknown) => ({ ok: false as const, err }),
    ),
  );
  if (!outcome.ok) {
    const err = outcome.err;
    const failed = record({ ok: false, error: (err instanceof Error ? err.message : String(err)).slice(0, 500), data: null, args: parsed.data, usd });
    // Out of cache or budget mid-tool (after a paid SAM call, say): the run ends, this step and its cost kept.
    if (err instanceof LiveBudgetError) return { step: failed, halt: "budget_exceeded" };
    if (err instanceof CacheMissError) return { step: failed, halt: "failed" };
    return { step: failed, halt: null };
  }
  const done = record({ ok: true, error: null, data: outcome.data, args: parsed.data, usd });
  seen.set(key, done);
  return { step: done, halt: null };
}

type Known = { timeline: Awaited<ReturnType<typeof getIncidentTimeline.run>> | null; around: Awaited<ReturnType<typeof searchIncidents.run>>["incidents"] };

// What the agent would otherwise spend its first steps looking up: the suggested incident's photos and the
// incidents of this kind nearby. Database reads only, no model calls.
async function preload(report: ReportInput, a: Analysis, ctx: ToolContext): Promise<Known> {
  const target = a.decision.incident_id;
  const [timeline, found] = await Promise.all([
    target ? getIncidentTimeline.run({ incident_id: target }, ctx).catch(() => null) : null,
    searchIncidents.run(
      { lat: report.lat, lng: report.lng, radius_m: SEARCH_CONFIG.verify_radius_m, days_back: SEARCH_CONFIG.days_back, category: a.triage.category === "other" ? null : a.triage.category },
      ctx,
    ),
  ]);
  return { timeline, around: found.incidents };
}

function contextMessage(report: ReportInput, a: Analysis, known: Known): string {
  const t = a.triage;
  const d = a.decision;
  const photos = [report.image_id, ...(report.answer_image_ids ?? [])];
  const lines = [
    `REPORT ${report.report_id}`,
    `- category: ${t.category}; problem: ${t.damage_present ? (t.damage_description ?? "visible") : "not visible"}; repair signs: ${t.repair_signs}; photo quality: ${t.image_quality}`,
    `- location: ${report.lat.toFixed(6)}, ${report.lng.toFixed(6)}; observed at: ${report.observed_at}`,
    `- photos of this report (use as new_image_id): ${photos.join(", ")}`,
    `- already asked resident: ${report.already_asked ? "yes" : "no"}`,
    "",
    "AUTOMATIC PIPELINE RESULT",
    `- decision: ${d.label}; blocked_rule: ${d.rule_id} — ${d.reasons.map((r) => r.text).join(" ")}`,
    `- candidates searched (radius ${SEARCH_CONFIG.radius_m[t.category]} m): ${
      a.candidates.map((c) => `${c.incident_id} (${c.status}, ${c.distance_m} m, resolved_at ${c.resolved_at ?? "none"})`).join("; ") || "none"
    }`,
    "- comparisons:",
    ...a.comparisons.map((c) => {
      const r = c.result;
      if (!r) return `  - ${c.incident_id}: ${c.new_image_id} vs ${c.candidate_image_id} (stage ${c.stage}) failed`;
      return (
        `  - ${c.incident_id}: ${c.new_image_id} vs ${c.candidate_image_id} (${c.stage === 2 ? "crops" : "full"}): asset ${r.asset_match.verdict} ` +
        `(${r.asset_match.confidence}), problem visible ${r.damage.new_damage_present}, signature ${r.damage.same_damage_signature}, ` +
        `repair signs ${r.damage.repair_signs_in_new}, missing ${r.missing_info.join(",") || "none"}`
      );
    }),
  ];
  if (a.comparisons.length === 0) lines.push("  - none");
  const compared = new Set(a.comparisons.map((c) => c.candidate_image_id));
  lines.push(
    "",
    `SUGGESTION TO VERIFY: ${d.label}${d.incident_id ? ` → ${d.incident_id}` : ""}`,
    known.timeline
      ? `- photos of ${known.timeline.incident_id} (${known.timeline.status}${known.timeline.resolved_at ? `, fixed ${known.timeline.resolved_at}` : ""}): ` +
          known.timeline.photos.map((p) => `${p.image_id} (observed ${p.observed_at}${compared.has(p.image_id) ? ", already compared" : ""})`).join("; ")
      : "- no incident to check",
    `- incidents of this kind within ${SEARCH_CONFIG.verify_radius_m} m: ${known.around.map((i) => `${i.incident_id} (${i.status}, ${i.distance_m} m, photos ${i.photo_ids.join(", ") || "none"})`).join("; ") || "none"}`,
  );
  return lines.join("\n");
}
