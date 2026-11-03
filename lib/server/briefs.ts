// Author: HyeonMo Gu
// Created: 2026-11-01

// Staff ask the brief agent to lay out a report's evidence. A brief only informs: it never changes the
// report, its status or its suggestion, so unlike a verification it needs no lease and no particular status.
import { count, desc, eq } from "drizzle-orm";
import { composeBrief, type BriefRun } from "../agent/brief";
import type { AgentStep } from "../agent/run";
import { briefs, reportAnalyses, reports } from "../db/schema";
import { CacheMissError, LiveBudgetError } from "../meta/call";
import { AGENT_LIMITS } from "../pipeline/config";
import { storedAnalysis, UserError } from "./reports";
import { runMode, toolContext, type Runtime } from "./runtime";

export type BriefResult =
  | { status: "finished"; brief_id: number; run: BriefRun }
  | { status: "not_started"; reason: "no_recording" | "budget" | "error"; message: string };

// What the brief route streams: each tool call as it finishes, then the result (or why it was refused).
export type BriefEvent =
  | { type: "step"; step: Pick<AgentStep, "step" | "ref" | "tool" | "ok" | "error" | "args" | "data"> }
  | { type: "result"; result: BriefResult }
  | { type: "error"; error: string };

/**
 * A brief of the analysis staff are looking at (analysisId, the report's latest). A run that cannot start
 * (nothing recorded to replay, no budget, an error before the first turn) stores nothing; one that starts is
 * stored whatever its end, with its steps and cost.
 */
export async function briefReport(rt: Runtime, reportId: string, analysisId: number, onStep?: (step: AgentStep) => void): Promise<BriefResult> {
  const { database } = rt;
  const [report] = await database.select().from(reports).where(eq(reports.id, reportId));
  if (!report) throw new UserError(`Unknown report ${reportId}`);
  const [latest] = await database.select().from(reportAnalyses).where(eq(reportAnalyses.report_id, reportId)).orderBy(desc(reportAnalyses.id)).limit(1);
  if (!latest || latest.id !== analysisId) throw new UserError("The report was analyzed again since this page loaded. Reload to brief the latest analysis.");
  if (!latest.input || !latest.triage) throw new UserError("This analysis predates stored inputs. Analyze the report again first.");
  // Two requests at once can both pass this count: without a lease the limit holds for requests in sequence.
  const [{ value: soFar }] = (await database.select({ value: count() }).from(briefs).where(eq(briefs.report_id, reportId))) as [{ value: number }];
  if (soFar >= AGENT_LIMITS.max_runs_per_report) throw new UserError(`This report has had ${soFar} briefs, the most allowed.`);

  const { input, analysis } = storedAnalysis(latest);
  const mode = await runMode(database, report, AGENT_LIMITS.max_usd);
  let run: BriefRun;
  try {
    run = await composeBrief(input, analysis, toolContext(rt, reportId, mode), AGENT_LIMITS, onStep);
  } catch (err) {
    if (err instanceof CacheMissError) return { status: "not_started", reason: "no_recording", message: err.message };
    if (err instanceof LiveBudgetError) return { status: "not_started", reason: "budget", message: err.message };
    console.error("brief could not start", err);
    return { status: "not_started", reason: "error", message: (err instanceof Error ? err.message : String(err)).slice(0, 500) };
  }
  const [stored] = await database
    .insert(briefs)
    .values({
      report_id: reportId,
      analysis_id: analysisId,
      requested_by: "staff",
      status: run.status,
      steps: run.steps,
      facts: run.facts,
      brief: run.brief,
      dropped: run.brief?.dropped ?? 0,
      error: run.error,
      cost_usd: run.cost_usd,
      latency_ms: run.latency_ms,
    })
    .returning({ id: briefs.id });
  return { status: "finished", brief_id: stored!.id, run };
}
