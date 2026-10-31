// Author: HyeonMo Gu
// Created: 2026-10-27

// Ids are text: the pipeline, the dataset and the evaluation all name things with readable string ids.
import { boolean, customType, doublePrecision, index, integer, jsonb, pgTable, real, serial, text, timestamp } from "drizzle-orm/pg-core";

const at = (name: string) => timestamp(name, { withTimezone: true, mode: "string" });
const createdAt = () => at("created_at").notNull().defaultNow();
// Drizzle has no bytea column; postgres-js returns a Buffer and PGlite a Uint8Array, both accepted as parameters.
const bytea = (name: string) => customType<{ data: Buffer; driverData: Buffer | Uint8Array }>({ dataType: () => "bytea", fromDriver: (v) => Buffer.from(v) })(name);

export const incidents = pgTable("incidents", {
  id: text("id").primaryKey(),
  category: text("category").notNull(),
  status: text("status").notNull(), // open | in_progress | resolved | closed
  lat: doublePrecision("lat").notNull(),
  lng: doublePrecision("lng").notNull(),
  title: text("title").notNull(),
  created_at: createdAt(),
  resolved_at: at("resolved_at"),
  recurrence_of: text("recurrence_of"),
  representative_report_id: text("representative_report_id"),
});

export const incidentEvents = pgTable(
  "incident_events",
  {
    id: serial("id").primaryKey(),
    incident_id: text("incident_id").notNull(),
    type: text("type").notNull(), // created | report_linked | status_changed | repair_recorded | recurrence_created | note
    actor: text("actor").notNull(), // staff | system
    summary: text("summary").notNull(),
    payload: jsonb("payload"),
    created_at: createdAt(),
  },
  (t) => [index("incident_events_incident").on(t.incident_id)],
);

export const reports = pgTable(
  "reports",
  {
    id: text("id").primaryKey(),
    tracking_code: text("tracking_code").notNull().unique(),
    incident_id: text("incident_id"),
    lat: doublePrecision("lat").notNull(),
    lng: doublePrecision("lng").notNull(),
    observed_at: at("observed_at").notNull(),
    observed_at_source: text("observed_at_source").notNull(), // user | exif | assumed_submit_time
    submitted_at: at("submitted_at").notNull(),
    description: text("description"),
    category_hint: text("category_hint"),
    channel: text("channel").notNull().default("photo"), // photo | photo_text | text | voice | voice_photo
    audio_path: text("audio_path"), // blob key of the recording
    transcript: text("transcript"), // set once the recording is transcribed
    danger: boolean("danger").notNull().default(false), // the resident ticked "someone may be in danger"
    urgent: boolean("urgent").notNull().default(false), // possible emergency (R0e): top of the staff queue
    error: text("error"), // why the last analysis failed (status "failed"); staff see it
    // received | analyzing | needs_info | under_review | unavailable | failed | linked | new_incident | dismissed
    status: text("status").notNull(),
    claimed_at: at("claimed_at"), // when the running analysis took the report; an old claim can be taken over
    verify_claimed_at: at("verify_claimed_at"), // when a staff-requested verification took the report; same lease as an analysis
    already_asked: boolean("already_asked").notNull().default(false),
    triage: jsonb("triage"), // { category, sam_prompt } once triage ran; crop comparisons segment with it
    live: boolean("live").notNull().default(false), // submitted with the access code: may make live model calls
    is_synthetic: boolean("is_synthetic").notNull(),
    dataset_case_id: text("dataset_case_id"),
  },
  (t) => [index("reports_incident").on(t.incident_id)],
);

export const images = pgTable(
  "images",
  {
    id: text("id").primaryKey(),
    report_id: text("report_id").notNull(), // crops point at the report of their source photo
    kind: text("kind").notNull(), // original | object_crop | context_crop
    source_image_id: text("source_image_id"),
    // Originals live in the blob store under storage_path; crops keep their bytes here, so segmenting a photo
    // costs no blob uploads (Vercel Blob counts each one against a monthly quota).
    storage_path: text("storage_path"),
    bytes: bytea("bytes"),
    mime: text("mime").notNull(),
    width: integer("width").notNull(),
    height: integer("height").notNull(),
    is_synthetic: boolean("is_synthetic").notNull(),
    dataset_image_id: text("dataset_image_id"),
    created_at: createdAt(),
  },
  (t) => [index("images_report").on(t.report_id)],
);

export const segmentations = pgTable(
  "segmentations",
  {
    id: serial("id").primaryKey(),
    image_id: text("image_id").notNull(),
    noun_phrase: text("noun_phrase").notNull(),
    found: boolean("found").notNull(),
    instances: integer("instances").notNull(),
    box: jsonb("box"),
    score: real("score"),
    mask_svg_path: text("mask_svg_path"), // UI overlay only, never sent to a model
    object_crop_id: text("object_crop_id"),
    context_crop_id: text("context_crop_id"),
    created_at: createdAt(),
  },
  (t) => [index("segmentations_image").on(t.image_id)],
);

export const reportAnalyses = pgTable(
  "report_analyses",
  {
    id: serial("id").primaryKey(),
    report_id: text("report_id").notNull(),
    pipeline_config: text("pipeline_config").notNull(),
    prompt_hash: jsonb("prompt_hash").notNull(),
    triage: jsonb("triage"), // null when the report never reached the photo pipeline
    intake: jsonb("intake"), // what the resident's words say, when there were any
    candidates: jsonb("candidates").notNull(),
    comparisons: jsonb("comparisons").notNull(),
    decision: jsonb("decision").notNull(), // the fast path's Decision
    final: jsonb("final").notNull(), // after the agent, if it ran: { label, incident_id, rule_id, missing_info }
    input: jsonb("input"), // the ReportInput the photo pipeline read; a verification decides again from it
    after_fix: jsonb("after_fix"), // the zoomed after-fix check, when the rules needed it
    errors: jsonb("errors").notNull(),
    cost_usd: real("cost_usd").notNull(),
    latency_ms: integer("latency_ms").notNull(),
    created_at: createdAt(),
  },
  (t) => [index("report_analyses_report").on(t.report_id)],
);

export const agentRuns = pgTable(
  "agent_runs",
  {
    id: serial("id").primaryKey(),
    report_id: text("report_id").notNull(),
    analysis_id: integer("analysis_id").notNull(),
    trigger: jsonb("trigger").notNull(),
    status: text("status").notNull(), // proposed | blocked | asked_resident | failed | budget_exceeded
    requested_by: text("requested_by").notNull().default("pipeline"), // pipeline (automatic) | staff
    applied: boolean("applied").notNull().default(true), // false: the report changed while it ran, so its result was not used
    steps: jsonb("steps").notNull(),
    proposal: jsonb("proposal"),
    guard: jsonb("guard"),
    question: jsonb("question"),
    error: text("error"),
    cost_usd: real("cost_usd").notNull(),
    latency_ms: integer("latency_ms").notNull(),
    created_at: createdAt(),
  },
  (t) => [index("agent_runs_report").on(t.report_id)],
);

export const infoRequests = pgTable("info_requests", {
  id: serial("id").primaryKey(),
  report_id: text("report_id").notNull(),
  analysis_id: integer("analysis_id").notNull(),
  question: text("question").notNull(),
  requested_items: jsonb("requested_items").notNull(),
  reason_for_staff: text("reason_for_staff"),
  source: text("source").notNull(), // template (a rule asked, in the template's words) | staff | agent
  status: text("status").notNull(), // pending | answered | expired
  response: jsonb("response"),
  created_at: createdAt(),
});

export const staffDecisions = pgTable("staff_decisions", {
  id: serial("id").primaryKey(),
  report_id: text("report_id").notNull(),
  analysis_id: integer("analysis_id"),
  suggested: text("suggested").notNull(),
  final_action: text("final_action").notNull(), // link | new_incident | recurrence | request_info | dismiss
  incident_id: text("incident_id"),
  agreed: boolean("agreed").notNull(),
  created_at: createdAt(),
});

export const llmCache = pgTable("llm_cache", {
  key: text("key").primaryKey(),
  model: text("model").notNull(),
  response: jsonb("response").notNull(),
  created_at: createdAt(),
});

// Every public reset of the demo world, so resets can be held to a cooldown. A reset leaves this table alone.
export const demoResets = pgTable("demo_resets", {
  id: serial("id").primaryKey(),
  created_at: createdAt(),
});

// Live model spend per UTC day, so a public deployment can stop at a cap.
export const spend = pgTable("spend", {
  day: text("day").primaryKey(), // YYYY-MM-DD
  usd: real("usd").notNull().default(0),
});
