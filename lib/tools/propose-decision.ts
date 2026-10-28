// Author: HyeonMo Gu
// Created: 2026-10-27

import { z } from "zod";
import type { Candidate, DecideInput } from "../pipeline/decide";
import { guard, type GuardStep } from "../pipeline/guard";
import type { ToolData } from "./data";
import { IncidentId, Label, type Tool } from "./types";

export const ProposeDecisionIn = z
  .object({
    label: z.enum(["NEW", "DUPLICATE", "LATE_REPORT", "POSSIBLE_RECURRENCE", "ALREADY_RESOLVED", "HUMAN_REVIEW"]),
    incident_id: IncidentId.nullable().describe("Required for DUPLICATE, LATE_REPORT, POSSIBLE_RECURRENCE, ALREADY_RESOLVED"),
    confidence: z.number(),
    evidence_refs: z
      .array(z.string())
      .describe('refs of tool results that support this, e.g. ["step_2","step_4"]. May be empty only for HUMAN_REVIEW'),
    rationale: z.string().describe("Max 400 characters, for staff"),
  })
  .strict();

export const ProposeDecisionOut = z
  .object({
    passed: z.boolean(),
    final_label: Label,
    final_incident_id: IncidentId.nullable(),
    decide_label: Label,
    blocked_rules: z.array(z.enum(["G1", "G2", "G3", "G4"])),
  })
  .strict();

type SearchData = { incidents: Array<{ incident_id: string; distance_m: number }> };
type CompareData = { candidate_incident_id: string };

export const proposeDecision: Tool<typeof ProposeDecisionIn, typeof ProposeDecisionOut> = {
  name: "propose_decision",
  description:
    "Submit your final proposal. It is checked by safety rules against the tool results you cite; " +
    "if it fails, the report goes to human review. Ends this run.",
  input: ProposeDecisionIn,
  output: ProposeDecisionOut,
  terminal: true,
  run: async (proposal, ctx) => {
    if (!ctx.investigation) throw new Error("propose_decision runs only inside an investigation");
    const { steps, base } = ctx.investigation;
    return guard({ proposal, steps, base, incidents: await incidentFacts(ctx.data, steps, base, proposal.incident_id) });
  },
};

/** Current facts for every incident a run touched (and `extra`), read from the data source, not the agent. */
export async function incidentFacts(data: ToolData, steps: GuardStep[], base: DecideInput, extra: string | null): Promise<Record<string, Candidate>> {
  const distances = new Map(base.candidates.map((c) => [c.incident_id, c.distance_m]));
  const ids = new Set(base.candidates.map((c) => c.incident_id));
  if (extra) ids.add(extra);
  for (const s of steps.filter((x) => x.ok)) {
    if (s.tool === "search_incidents") {
      for (const i of (s.data as SearchData).incidents) {
        ids.add(i.incident_id);
        distances.set(i.incident_id, i.distance_m);
      }
    }
    if (s.tool === "compare_images") ids.add((s.data as CompareData).candidate_incident_id);
  }
  const incidents: Record<string, Candidate> = {};
  for (const id of ids) {
    const row = await data.incident(id);
    if (!row) continue;
    incidents[id] = {
      incident_id: row.id,
      status: row.status,
      created_at: row.created_at,
      resolved_at: row.resolved_at,
      recurrence_of: row.recurrence_of,
      distance_m: distances.get(id) ?? 0,
    };
  }
  return incidents;
}
