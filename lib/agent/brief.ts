// Author: HyeonMo Gu
// Created: 2026-11-01

// The brief agent: Muse Spark looks at a report's evidence with the verification agent's tools and writes a
// case brief for staff. It never proposes a label and never touches the report or its suggestion. Every item
// cites a fact of its first message or a tool result; write_brief deletes the items that cite neither. Same
// limits, neutral names and step record as the verification agent (run.ts).
import { CacheMissError, LiveBudgetError, metered } from "../meta/call";
import { functionCalls, sparkRespond } from "../meta/responses";
import { decideInputOf, type Analysis, type ReportInput } from "../pipeline/analyze";
import type { Comparison } from "../pipeline/decide";
import { AGENT_LIMITS, SEARCH_CONFIG } from "../pipeline/config";
import { loadPrompt } from "../prompts";
import { compareImages } from "../tools/compare-images";
import { getIncidentTimeline } from "../tools/get-incident-timeline";
import { dataUrl } from "../tools/images";
import { toFunctionTool } from "../tools/json-schema";
import { searchIncidents } from "../tools/search-incidents";
import { segmentObject } from "../tools/segment-object";
import type { ToolContext } from "../tools/types";
import { writeBrief, type Brief } from "../tools/write-brief";
import { Aliases } from "./aliases";
import { beforeDeadline, preload, runStep, type AgentStep, type AnyTool, type Known } from "./run";

const TOOLS = [searchIncidents, getIncidentTimeline, segmentObject, compareImages, writeBrief] as unknown as AnyTool[];
const TERMINAL = TOOLS.filter((t) => t.terminal);
const MAX_FACTS = 40;
const MAX_ERRORS_CHARS = 300;

export type BriefFact = { ref: string; text: string }; // text with real ids (what staff see)

export type BriefRun = {
  status: "written" | "failed" | "budget_exceeded";
  steps: AgentStep[];
  facts: BriefFact[];
  brief: Brief | null; // null when the run ended without write_brief
  error: string | null; // why a run without a brief stopped
  cost_usd: number;
  latency_ms: number;
};

export async function composeBrief(
  report: ReportInput,
  analysis: Analysis,
  ctx: ToolContext,
  limits: typeof AGENT_LIMITS = AGENT_LIMITS,
  onStep?: (step: AgentStep) => void,
): Promise<BriefRun> {
  const start = Date.now();
  const timeout = AbortSignal.timeout(limits.max_ms);
  const steps: AgentStep[] = [];
  const prompt = await loadPrompt("brief");
  const photo = await ctx.images.get(report.image_id);
  const known = await preload(report, analysis, ctx);
  const facts = briefFacts(report, analysis, known);
  const runCtx: ToolContext = {
    ...ctx,
    // Not for a proposal (none is offered): runStep reads these steps to allow a comparison again after
    // either image was segmented again, as in a verification.
    investigation: { steps, base: decideInputOf(report, analysis) },
    briefing: { steps, fact_refs: facts.map((f) => f.ref) },
    signal: timeout,
    compareModel: limits.compare_model,
  };
  const names = new Aliases();
  names.collect({ report, analysis: { decision: analysis.decision, candidates: analysis.candidates, comparisons: analysis.comparisons }, known });
  const text = [`REPORT ${report.report_id}`, "FACTS", ...facts.map((f) => `${f.ref}: ${f.text}`)].join("\n");
  const input: unknown[] = [
    { role: "system", content: prompt.text.replace("{max_steps}", String(limits.max_steps)) },
    {
      role: "user",
      content: [
        { type: "input_text", text: names.mask(text) },
        { type: "input_text", text: "IMAGE R1 — the report's main photo" },
        { type: "input_image", image_url: dataUrl(await ctx.images.bytes(report.image_id), photo?.mime ?? "image/webp") },
      ],
    },
  ];

  let usd = 0;
  let status: BriefRun["status"] | null = null;
  let brief: Brief | null = null;
  let error: string | null = null;
  const seen = new Map<string, AgentStep>();
  const deadline = start + limits.max_ms;
  let turns = 0;
  // The same limits as a verification: checked before every model turn and every tool call.
  const exhausted = () => steps.length >= limits.max_steps || usd + limits.call_usd_estimate > limits.max_usd || Date.now() >= deadline;
  // Near any limit only write_brief is offered, so a run ends with a brief instead of being cut off.
  let wrapUp = false; // set when the model stopped calling tools: it gets the closing turns to write
  const closing = () => wrapUp || steps.length >= limits.max_steps - 1 || deadline - Date.now() < limits.closing_ms || usd + 2 * limits.call_usd_estimate > limits.max_usd;
  const closingNote = (await loadPrompt("brief_closing")).text;
  let closingTurns = 0;

  try {
    turns: while (status === null) {
      if (exhausted()) {
        status = "budget_exceeded";
        break;
      }
      const offered = closing() ? TERMINAL : TOOLS;
      if (offered === TERMINAL) {
        // One reminder and two chances: a model that still will not write ends the run.
        if (closingTurns === 0) input.push({ role: "user", content: [{ type: "input_text", text: closingNote }] });
        if (closingTurns >= 2) {
          status = "budget_exceeded";
          break;
        }
        closingTurns += 1;
      }
      const signal = AbortSignal.timeout(Math.max(1, deadline - Date.now()));
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
        if (closing() && !TERMINAL.some((t) => t.name === call.name)) {
          const error = "Not run: only write_brief is available now.";
          input.push({ type: "function_call_output", call_id: call.call_id, output: JSON.stringify({ ok: false, error, steps_left: limits.max_steps - steps.length }) });
          continue;
        }
        const { step, halt } = await runStep(call.name, names.unmask(call.arguments), steps.length + 1, runCtx, seen, offered, deadline);
        usd += step.usd;
        steps.push(step);
        try {
          onStep?.(step);
        } catch (err) {
          console.error("step listener failed", err);
        }
        if (halt) {
          status = halt;
          error = step.error;
          break turns;
        }
        const steps_left = limits.max_steps - steps.length;
        names.collect(step.data);
        input.push({ type: "function_call_output", call_id: call.call_id, output: names.mask(JSON.stringify({ ref: step.ref, ok: step.ok, error: step.error, data: step.data, steps_left })) });
        if (step.ok && step.tool === "write_brief") {
          // Staff read real ids; the model wrote the neutral names.
          const written = step.data as Brief;
          brief = {
            ...written,
            summary: written.summary && { ...written.summary, text: names.unmask(written.summary.text) },
            items: written.items.map((item) => ({ ...item, text: names.unmask(item.text) })),
          };
          status = "written";
          break turns;
        }
      }
    }
  } catch (err) {
    // Before any turn, a replay-only deployment or a spent daily budget is the caller's to handle.
    if ((err instanceof CacheMissError || err instanceof LiveBudgetError) && turns === 0) throw err;
    status = err instanceof LiveBudgetError || Date.now() >= deadline ? "budget_exceeded" : "failed";
    error = (err instanceof Error ? err.message : String(err)).slice(0, 500);
  }

  return { status: status!, steps, facts, brief, error, cost_usd: usd, latency_ms: Date.now() - start };
}

// What the stored analysis and the preload already show, numbered so the brief can cite each line.
// Database reads only, no model calls; times stay ISO so a replayed run's first turn matches its recording.
// The brief itself writes no dates, only times relative to each other (prompts/brief.md): a replayed brief
// is replayed word for word on a later day, and staff read dates in the demo's zone, not in UTC.
function briefFacts(report: ReportInput, a: Analysis, known: Known): BriefFact[] {
  const t = a.triage;
  const d = a.decision;
  const answers = report.answer_image_ids ?? [];
  const reasons = d.reasons.map((r) => r.text).join(" ");
  const compared = new Set(a.comparisons.map((c) => c.candidate_image_id));
  const timeline = known.timeline;
  const errors = a.errors.join("; ");
  // A suggestion to ask is sent to the resident with it, so by the time staff read a brief the question is out;
  // report.already_asked is the analysis input, from before this suggestion asked. Other suggestions keep their line.
  const asked = d.label === "NEEDS_INFO" ? `yes, by this suggestion (${d.missing_info.join(", ") || "one question"}), no answer yet` : report.already_asked ? "yes" : "no";
  const lines: string[] = [
    `category ${t.category}; problem: ${t.damage_present ? (t.damage_description ?? "visible") : "not visible"}; repair signs: ${t.repair_signs}; photo quality: ${t.image_quality}; out of scope: ${t.out_of_scope}`,
    `observed at ${report.observed_at}; location ${report.lat.toFixed(6)}, ${report.lng.toFixed(6)}; photos: ${report.image_id} (main)` +
      `${answers.length ? `, ${answers.join(", ")} (answers)` : ""}; resident already asked: ${asked}`,
    `pipeline suggestion ${d.label}${d.incident_id ? ` → ${d.incident_id}` : ""} by rule ${d.rule_id}${reasons ? `: ${reasons}` : ""}`,
    ...a.candidates.map((c) => `candidate ${c.incident_id}: ${c.status}, ${c.distance_m} m, created ${c.created_at}, resolved ${c.resolved_at ?? "never"}`),
    ...a.comparisons.map(comparisonFact),
    ...Object.entries(a.after_fix ?? {}).map(
      ([imageId, r]) => `zoomed after-fix check of ${imageId}: ${r.problem_found ? `problem found${r.description ? ` (${r.description})` : ""}` : "no problem found"}`,
    ),
    ...(errors ? [`calls that failed: ${errors.slice(0, MAX_ERRORS_CHARS)}`] : []),
    ...(timeline
      ? [
          ...timeline.events.map((e) => `incident ${timeline.incident_id} event ${e.type} at ${e.at}: ${e.summary}`),
          `photos of ${timeline.incident_id} (${timeline.status}${timeline.resolved_at ? `, fixed ${timeline.resolved_at}` : ""}): ` +
            (timeline.photos.map((p) => `${p.image_id} (observed ${p.observed_at}${compared.has(p.image_id) ? ", already compared" : ""})`).join("; ") || "none"),
        ]
      : []),
    ...(known.around.length
      ? known.around.map((i) => `nearby ${i.incident_id}: ${i.status}, ${i.distance_m} m, photos ${i.photo_ids.join(", ") || "none"}`)
      : [`nearby: no incidents of this kind within ${SEARCH_CONFIG.verify_radius_m} m`]),
  ];
  return lines.slice(0, MAX_FACTS).map((text, i) => ({ ref: `fact_${String(i + 1).padStart(2, "0")}`, text }));
}

// The verification agent's wording for a comparison (run.ts contextMessage), as one fact.
function comparisonFact(c: Comparison): string {
  const r = c.result;
  const pair = `comparison for ${c.incident_id}: ${c.new_image_id} vs ${c.candidate_image_id}`;
  if (!r) return `${pair} (stage ${c.stage}) failed`;
  // The model's own notes on the damage in each photo: without them "signature different" leaves the brief to
  // guess what the earlier photo showed.
  const notes = r.damage.evidence.slice(0, 2).map((e) => e.slice(0, 140));
  return (
    `${pair} (${c.stage === 2 ? "crops" : "full"}): asset ${r.asset_match.verdict} (${r.asset_match.confidence}), ` +
    `problem visible ${r.damage.new_damage_present}, signature ${r.damage.same_damage_signature}, ` +
    `repair signs ${r.damage.repair_signs_in_new}, missing ${r.missing_info.join(",") || "none"}` +
    (notes.length ? `; problem notes: ${notes.join("; ")}` : "")
  );
}
