// Author: HyeonMo Gu
// Created: 2026-10-27

// Shared schemas and the tool shape. The pipeline and the investigation agent call the same
// tools, so everything that crosses a tool boundary is defined here once.
import { z } from "zod";
import type { ToolData } from "./data";
import type { DecideInput } from "../pipeline/decide";
import type { GuardStep } from "../pipeline/guard";
import type { ImageStore } from "./images";

// Fixed assets (hydrant, light, sign, bench) and problems tied to a place (road damage, trash, graffiti).
// Reports about people or behavior are out of scope: triage flags them and staff handle them directly.
export const Category = z.enum([
  "fire_hydrant",
  "streetlight",
  "traffic_sign",
  "bench",
  "road_damage",
  "trash",
  "graffiti",
  "other",
]);
export const IncidentStatus = z.enum(["open", "in_progress", "resolved", "closed"]);
export const IncidentEventType = z.enum([
  "created",
  "report_linked",
  "status_changed",
  "repair_recorded",
  "recurrence_created",
  "note",
]);
export const Label = z.enum([
  "NEW",
  "DUPLICATE",
  "LATE_REPORT",
  "POSSIBLE_RECURRENCE",
  "ALREADY_RESOLVED",
  "NEEDS_INFO",
  "HUMAN_REVIEW",
]);
export const MissingItem = z.enum(["close_up", "wider_context", "different_angle", "observed_time"]);
// What a resident can be asked for. "photo" serves reports sent without one; it stays out of MissingItem,
// which is part of the comparison schema the model answers in.
export const RequestItem = z.enum([...MissingItem.options, "photo"]);
// How a report arrived, read from what was attached (never from a model).
export const Channel = z.enum(["photo", "photo_text", "text", "voice", "voice_photo"]);
export const ImageId = z.string().describe("Image id (original photo or crop), e.g. img_8f2c");
export const IncidentId = z.string().describe("Incident id, e.g. inc_31a0");
export const Box = z
  .object({
    x1: z.number(),
    y1: z.number(),
    x2: z.number(),
    y2: z.number(),
    w: z.number().describe("source image width in px"),
    h: z.number().describe("source image height in px"),
  })
  .strict();

// Visual comparison of a new photo against one candidate incident photo. No time information:
// the model judges what it sees, and decide.ts judges time.
export const CompareResult = z
  .object({
    asset_match: z
      .object({
        verdict: z.enum(["same", "different", "uncertain"]),
        confidence: z.number(),
        evidence: z.array(z.string()),
      })
      .strict(),
    damage: z
      .object({
        new_damage_present: z.boolean(),
        candidate_damage_present: z.boolean(),
        same_damage_signature: z.enum(["same", "different", "uncertain"]),
        repair_signs_in_new: z.boolean(),
        evidence: z.array(z.string()),
      })
      .strict(),
    view_change: z.enum(["same_view", "different_angle", "different_distance"]),
    missing_info: z.array(MissingItem),
    summary: z.string().describe("One sentence for staff"),
  })
  .strict();

export type Category = z.infer<typeof Category>;
export type IncidentStatus = z.infer<typeof IncidentStatus>;
export type IncidentEventType = z.infer<typeof IncidentEventType>;
export type Label = z.infer<typeof Label>;
export type MissingItem = z.infer<typeof MissingItem>;
export type RequestItem = z.infer<typeof RequestItem>;
export type Channel = z.infer<typeof Channel>;
export type Box = z.infer<typeof Box>;
export type CompareResult = z.infer<typeof CompareResult>;

export type ToolContext = {
  reportId: string;
  runId: string | null; // null when called from the fixed pipeline
  mode: "live" | "cached" | "cached_then_live";
  budget: { usdLeft: number; deadline: number };
  data: ToolData;
  images: ImageStore;
  investigation?: Investigation; // set while the agent runs; the terminal tools read it
  signal?: AbortSignal; // set while the agent runs: model calls inside tools stop at its deadline
  compareModel?: string; // set while the agent runs: its comparisons may use another model than the fast path's

};

export type Tool<I extends z.ZodType, O extends z.ZodType> = {
  name: string;
  description: string; // read by the model as the function tool description
  input: I;
  output: O;
  terminal?: boolean; // the agent run ends after this tool
  run: (input: z.infer<I>, ctx: ToolContext) => Promise<z.infer<O>>;
};

/** The agent run so far: its recorded steps and the fast path's input it started from. */
export type Investigation = { steps: GuardStep[]; base: DecideInput };

// What the agent sees for each tool call. `ref` is the agent_runs.steps id that
// propose_decision must cite in evidence_refs.
export const ToolEnvelope = <O extends z.ZodType>(data: O) =>
  z
    .object({
      ref: z.string().describe("Cite this in evidence_refs, e.g. step_3"),
      ok: z.boolean(),
      error: z.string().nullable(),
      data: data.nullable(),
    })
    .strict();
