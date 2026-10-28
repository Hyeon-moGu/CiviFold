// Author: HyeonMo Gu
// Created: 2026-10-27

// D_hybrid: the fast path decides; the agent verifies the suggestions that would let staff close a report
// in one click (DUPLICATE, LATE_REPORT, ALREADY_RESOLVED), looking for evidence against them: the incident's
// other photos, look-alikes nearby. The rules then decide again on everything it found, and the most
// cautious of the fast path, that recheck and a proposal the guardrail passed stands. The agent can stop a
// wrong suggestion; it can never make one less cautious.
// The evaluation's D_hybrid runs the agent on every such suggestion. The app runs the fast path alone and
// verifies a stored suggestion when staff ask (verifySuggestion), with the same combination of answers.
import { investigate, type AgentRun, type AgentStep } from "../agent/run";
import { CacheMissError, LiveBudgetError } from "../meta/call";
import { incidentFacts } from "../tools/propose-decision";
import type { Label, MissingItem, ToolContext } from "../tools/types";
import { analyze, decideInputOf, type Analysis, type ReportInput } from "./analyze";
import { AGENT_LIMITS } from "./config";
import { CAUTION, recheck } from "./guard";

// reason: the last rule's (or the agent's) words for staff, so a changed answer explains itself.
type Outcome = { label: Label; incident_id: string | null; rule_id: string; missing_info: MissingItem[]; reason?: string };

export type HybridResult = { analysis: Analysis; agent: AgentRun | null; decision: Outcome };

export const VERIFIED: ReadonlySet<Label> = new Set(["DUPLICATE", "LATE_REPORT", "ALREADY_RESOLVED"]);
const LINKED: ReadonlySet<Label> = new Set(["DUPLICATE", "LATE_REPORT", "ALREADY_RESOLVED", "POSSIBLE_RECURRENCE"]);
const UNVERIFIED: Outcome = { label: "HUMAN_REVIEW", incident_id: null, rule_id: "verify:unfinished", missing_info: [] };

export async function analyzeHybrid(report: ReportInput, ctx: ToolContext, agentRunsSoFar = 0): Promise<HybridResult> {
  const analysis = await analyze(report, ctx);
  const d = analysis.decision;
  const fast: Outcome = { label: d.label, incident_id: d.incident_id, rule_id: d.rule_id, missing_info: d.missing_info };
  if (!VERIFIED.has(d.label) || agentRunsSoFar >= AGENT_LIMITS.max_runs_per_report) return { analysis, agent: null, decision: fast };

  let agent: AgentRun;
  try {
    agent = await investigate(report, analysis, ctx);
  } catch (err) {
    // A replay-only deployment or a spent daily budget cannot run the agent. An unchecked burying suggestion
    // is not offered as one click: staff decide.
    if (!(err instanceof CacheMissError || err instanceof LiveBudgetError)) console.error("agent run failed before recording", err);
    return { analysis, agent: null, decision: UNVERIFIED };
  }
  const options = await answersOf(report, analysis, agent, ctx);
  // A run that ended before a proposal the guardrail passed has not verified the suggestion.
  if (agent.status === "budget_exceeded" || agent.status === "failed") options.push(UNVERIFIED);
  return { analysis, agent, decision: mostCautious(options) };
}

// The fast path's answer, the rules on its facts plus every tool result of the run (whatever the agent
// proposed, and however far it got), and a proposal the guardrail passed.
async function answersOf(report: ReportInput, analysis: Analysis, agent: AgentRun, ctx: ToolContext): Promise<Outcome[]> {
  const d = analysis.decision;
  const fast: Outcome = { label: d.label, incident_id: d.incident_id, rule_id: d.rule_id, missing_info: d.missing_info };
  const base = decideInputOf(report, analysis);
  const again = recheck({ steps: agent.steps, base, incidents: await incidentFacts(ctx.data, agent.steps, base, d.incident_id) });
  const options: Outcome[] = [
    { ...fast, reason: d.reasons.at(-1)?.text },
    { label: again.label, incident_id: again.incident_id, rule_id: again.rule_id, missing_info: again.missing_info, reason: again.reasons.at(-1)?.text },
  ];
  if (agent.guard?.passed) {
    options.push({ label: agent.final.label, incident_id: agent.final.incident_id, rule_id: `agent:${agent.status}`, missing_info: agent.final.missing_info, reason: agent.proposal?.rationale });
  }
  return options;
}

export type Verification =
  | { started: false; reason: "no_recording" | "budget" | "error"; message: string }
  | { started: true; agent: AgentRun; decision: Outcome };

/**
 * A staff-requested check of a stored fast-path suggestion. A run that cannot start (nothing recorded to
 * replay, no budget, an error before the first turn) leaves the suggestion as it is. A run that starts and
 * stops partway keeps what it found: its tool results go through the rules like a finished run's. The fast
 * path stays the default answer, so an unfinished check adds no HUMAN_REVIEW of its own.
 */
export async function verifySuggestion(report: ReportInput, analysis: Analysis, ctx: ToolContext, onStep?: (step: AgentStep) => void): Promise<Verification> {
  if (!VERIFIED.has(analysis.decision.label)) throw new Error(`Only a closing suggestion is verified, not ${analysis.decision.label}`);
  let agent: AgentRun;
  try {
    agent = await investigate(report, analysis, ctx, AGENT_LIMITS, onStep);
  } catch (err) {
    if (err instanceof CacheMissError) return { started: false, reason: "no_recording", message: err.message };
    if (err instanceof LiveBudgetError) return { started: false, reason: "budget", message: err.message };
    console.error("verification could not start", err);
    return { started: false, reason: "error", message: (err instanceof Error ? err.message : String(err)).slice(0, 500) };
  }
  return { started: true, agent, decision: mostCautious(await answersOf(report, analysis, agent, ctx)) };
}

// Ties keep the earlier option, so a run that only confirms leaves the fast path's own rule on record.
function mostCautious(options: Outcome[]): Outcome {
  // Answers linking the report to different incidents: which one, if any, is for staff.
  if (new Set(options.filter((o) => LINKED.has(o.label)).map((o) => o.incident_id)).size > 1) {
    return { label: "HUMAN_REVIEW", incident_id: null, rule_id: "verify:conflict", missing_info: [] };
  }
  return options.reduce((a, b) => (CAUTION[b.label] > CAUTION[a.label] ? b : a));
}
