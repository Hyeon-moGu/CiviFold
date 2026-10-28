// Author: HyeonMo Gu
// Created: 2026-10-27

import { beforeEach, describe, expect, it, vi } from "vitest";
import { investigate, type AgentRun, type AgentStep } from "../agent/run";
import { CacheMissError, LiveBudgetError } from "../meta/call";
import { memoryData } from "../tools/data";
import type { ToolContext } from "../tools/types";
import { cand, cmp, R, TEST_CONFIG } from "./__fixtures__/builders";
import { analyze, type Analysis, type ReportInput } from "./analyze";
import type { Comparison, Decision } from "./decide";
import { analyzeHybrid, verifySuggestion } from "./hybrid";

vi.mock("./analyze", async (original) => ({ ...(await original<typeof import("./analyze")>()), analyze: vi.fn() }));
vi.mock("../agent/run", () => ({ investigate: vi.fn() }));
vi.mock("./config", async (original) => {
  const real = await original<typeof import("./config")>();
  return { ...real, DECIDE_CONFIG: TEST_CONFIG };
});

const REPORT: ReportInput = { report_id: "r", image_id: "img_new", lat: 0, lng: 0, observed_at: R, description: null, category_hint: null, already_asked: false };
const I1 = cand("I1", "open");
const CTX = {
  data: memoryData({
    asOf: R,
    incidents: [{ id: "I1", category: "fire_hydrant", status: "open", lat: 0, lng: 0, title: "I1", created_at: I1.created_at, resolved_at: null, recurrence_of: null, representative_report_id: null }],
  }),
} as unknown as ToolContext;

// The fast path saw I1 through its crops and suggests a duplicate.
function fastPath(decision: Partial<Decision>, comparisons: Comparison[] = [cmp("I1", "same", 0.9)]) {
  vi.mocked(analyze).mockResolvedValue({
    triage: { image_quality: "ok", out_of_scope: false, category: "fire_hydrant" },
    candidates: [I1],
    comparisons,
    decision: { label: "DUPLICATE", incident_id: "I1", rule_id: "R6a", reasons: [], confidence: 0.9, missing_info: [], ...decision },
  } as unknown as Analysis);
}

/** An agent run whose steps compared the report photo with another photo of I1. */
function agentRan(verdict: "same" | "different", proposal: { label: Decision["label"]; incident_id: string | null; passed: boolean } | null = null) {
  const c = cmp("I1", verdict, 0.9);
  const step: AgentStep = {
    ref: "step_1",
    step: 1,
    tool: "compare_images",
    ok: true,
    args: { new_image_id: "img_new", candidate_image_id: "img_I1_other", mode: "crops" },
    data: { ...c.result, candidate_incident_id: "I1", mode: "crops" },
    error: null,
    ms: 0,
    usd: 0,
  };
  vi.mocked(investigate).mockResolvedValue({
    status: proposal ? (proposal.passed ? "proposed" : "blocked") : "budget_exceeded",
    steps: [step],
    guard: proposal ? { passed: proposal.passed } : null,
    final: proposal ? { label: proposal.label, incident_id: proposal.incident_id, missing_info: [] } : { label: "HUMAN_REVIEW", incident_id: null, missing_info: [] },
  } as unknown as AgentRun);
}

beforeEach(() => {
  vi.mocked(investigate).mockReset();
});

describe("analyzeHybrid", () => {
  it.each([
    ["a new problem", "NEW", "R3"],
    ["a recurrence", "POSSIBLE_RECURRENCE", "R7d"],
    ["a question", "NEEDS_INFO", "R5"],
    ["a report for staff", "HUMAN_REVIEW", "R4"],
  ] as const)("leaves %s to the fast path: only burying suggestions are verified", async (_, label, rule_id) => {
    fastPath({ label, rule_id, incident_id: label === "POSSIBLE_RECURRENCE" ? "I1" : null });
    const r = await analyzeHybrid(REPORT, CTX);
    expect(r.agent).toBeNull();
    expect(r.decision).toMatchObject({ label, rule_id });
    expect(investigate).not.toHaveBeenCalled();
  });

  it("keeps a suggestion the agent's comparisons confirm, with the fast path's rule on record", async () => {
    fastPath({});
    agentRan("same", { label: "DUPLICATE", incident_id: "I1", passed: true });
    const r = await analyzeHybrid(REPORT, CTX);
    expect(investigate).toHaveBeenCalledOnce();
    expect(r.decision).toEqual({ label: "DUPLICATE", incident_id: "I1", rule_id: "R6a", missing_info: [] });
  });

  it("stops a duplicate when another photo of the incident disagrees, whatever the agent proposed", async () => {
    fastPath({});
    agentRan("different", null); // ran out of budget before proposing: its comparison still counts
    const r = await analyzeHybrid(REPORT, CTX);
    expect(r.decision).toMatchObject({ label: "NEEDS_INFO", rule_id: "R5" });
  });

  it("takes a more cautious proposal the guardrail passed", async () => {
    fastPath({});
    agentRan("same", { label: "HUMAN_REVIEW", incident_id: null, passed: true });
    expect((await analyzeHybrid(REPORT, CTX)).decision).toMatchObject({ label: "HUMAN_REVIEW", rule_id: "agent:proposed" });
  });

  it("never takes a less cautious proposal", async () => {
    fastPath({ label: "LATE_REPORT", rule_id: "R7a" }, [cmp("I1", "same", 0.9)]);
    agentRan("same", { label: "ALREADY_RESOLVED", incident_id: "I1", passed: true });
    expect((await analyzeHybrid(REPORT, CTX)).decision.label).not.toBe("ALREADY_RESOLVED");
  });

  it("sends answers that link different incidents to staff", async () => {
    fastPath({});
    agentRan("same", { label: "DUPLICATE", incident_id: "I9", passed: true });
    expect((await analyzeHybrid(REPORT, CTX)).decision).toMatchObject({ label: "HUMAN_REVIEW", rule_id: "verify:conflict" });
  });

  it("sends a suggestion to staff when the run ends before verifying it", async () => {
    fastPath({});
    agentRan("same", null);
    expect((await analyzeHybrid(REPORT, CTX)).decision).toEqual({ label: "HUMAN_REVIEW", incident_id: null, rule_id: "verify:unfinished", missing_info: [] });
  });

  it("sends a suggestion to staff when the agent cannot make live calls", async () => {
    fastPath({});
    vi.mocked(investigate).mockRejectedValue(new CacheMissError("replay only"));
    const r = await analyzeHybrid(REPORT, CTX);
    expect(r.agent).toBeNull();
    expect(r.decision).toMatchObject({ label: "HUMAN_REVIEW", rule_id: "verify:unfinished" });
  });

  it("stops calling the agent after two runs for one report", async () => {
    fastPath({});
    const r = await analyzeHybrid(REPORT, CTX, 2);
    expect(r.agent).toBeNull();
    expect(investigate).not.toHaveBeenCalled();
  });
});

describe("verifySuggestion", () => {
  // The stored analysis a staff member asks to verify: the same shape analyze() returns.
  const stored = async () => {
    fastPath({});
    return analyze(REPORT, CTX);
  };

  it.each([
    [new CacheMissError("replay only"), "no_recording"],
    [new LiveBudgetError("budget used up"), "budget"],
    [new Error("database down"), "error"],
  ] as const)("does not start, and leaves the suggestion as it is, when the agent cannot run (%s)", async (err, reason) => {
    vi.mocked(investigate).mockRejectedValue(err);
    vi.spyOn(console, "error").mockImplementation(() => {});
    expect(await verifySuggestion(REPORT, await stored(), CTX)).toMatchObject({ started: false, reason });
  });

  it("keeps the counter-evidence of a run that stopped partway", async () => {
    agentRan("different", null); // budget_exceeded after one comparison
    const r = await verifySuggestion(REPORT, await stored(), CTX);
    expect(r).toMatchObject({ started: true, agent: { status: "budget_exceeded" }, decision: { label: "NEEDS_INFO", rule_id: "R5" } });
  });

  it("keeps the fast path's suggestion when a run stops partway without evidence against it", async () => {
    agentRan("same", null);
    const r = await verifySuggestion(REPORT, await stored(), CTX);
    // Unlike the evaluation's D_hybrid, an unfinished staff-requested check adds no HUMAN_REVIEW of its own.
    expect(r).toMatchObject({ started: true, decision: { label: "DUPLICATE", rule_id: "R6a" } });
  });

  it("combines a finished run like D_hybrid does", async () => {
    agentRan("same", { label: "HUMAN_REVIEW", incident_id: null, passed: true });
    expect(await verifySuggestion(REPORT, await stored(), CTX)).toMatchObject({ started: true, decision: { label: "HUMAN_REVIEW", rule_id: "agent:proposed" } });
  });

  it("verifies only a closing suggestion", async () => {
    fastPath({ label: "NEW", rule_id: "R3", incident_id: null });
    await expect(verifySuggestion(REPORT, await analyze(REPORT, CTX), CTX)).rejects.toThrow(/closing suggestion/);
  });
});
