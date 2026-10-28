CREATE TABLE "agent_runs" (
	"id" serial PRIMARY KEY NOT NULL,
	"report_id" text NOT NULL,
	"analysis_id" integer NOT NULL,
	"trigger" jsonb NOT NULL,
	"status" text NOT NULL,
	"steps" jsonb NOT NULL,
	"proposal" jsonb,
	"guard" jsonb,
	"question" jsonb,
	"cost_usd" real NOT NULL,
	"latency_ms" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "images" (
	"id" text PRIMARY KEY NOT NULL,
	"report_id" text NOT NULL,
	"kind" text NOT NULL,
	"source_image_id" text,
	"storage_path" text NOT NULL,
	"mime" text NOT NULL,
	"width" integer NOT NULL,
	"height" integer NOT NULL,
	"is_synthetic" boolean NOT NULL,
	"dataset_image_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "incident_events" (
	"id" serial PRIMARY KEY NOT NULL,
	"incident_id" text NOT NULL,
	"type" text NOT NULL,
	"actor" text NOT NULL,
	"summary" text NOT NULL,
	"payload" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "incidents" (
	"id" text PRIMARY KEY NOT NULL,
	"category" text NOT NULL,
	"status" text NOT NULL,
	"lat" double precision NOT NULL,
	"lng" double precision NOT NULL,
	"title" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"resolved_at" timestamp with time zone,
	"recurrence_of" text,
	"representative_report_id" text
);
--> statement-breakpoint
CREATE TABLE "info_requests" (
	"id" serial PRIMARY KEY NOT NULL,
	"report_id" text NOT NULL,
	"analysis_id" integer NOT NULL,
	"question" text NOT NULL,
	"requested_items" jsonb NOT NULL,
	"reason_for_staff" text,
	"source" text NOT NULL,
	"status" text NOT NULL,
	"response" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "llm_cache" (
	"key" text PRIMARY KEY NOT NULL,
	"model" text NOT NULL,
	"response" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "report_analyses" (
	"id" serial PRIMARY KEY NOT NULL,
	"report_id" text NOT NULL,
	"pipeline_config" text NOT NULL,
	"prompt_hash" jsonb NOT NULL,
	"triage" jsonb NOT NULL,
	"candidates" jsonb NOT NULL,
	"comparisons" jsonb NOT NULL,
	"decision" jsonb NOT NULL,
	"final" jsonb NOT NULL,
	"errors" jsonb NOT NULL,
	"cost_usd" real NOT NULL,
	"latency_ms" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "reports" (
	"id" text PRIMARY KEY NOT NULL,
	"tracking_code" text NOT NULL,
	"incident_id" text,
	"lat" double precision NOT NULL,
	"lng" double precision NOT NULL,
	"observed_at" timestamp with time zone NOT NULL,
	"observed_at_source" text NOT NULL,
	"submitted_at" timestamp with time zone NOT NULL,
	"description" text,
	"category_hint" text,
	"status" text NOT NULL,
	"already_asked" boolean DEFAULT false NOT NULL,
	"triage" jsonb,
	"live" boolean DEFAULT false NOT NULL,
	"is_synthetic" boolean NOT NULL,
	"dataset_case_id" text,
	CONSTRAINT "reports_tracking_code_unique" UNIQUE("tracking_code")
);
--> statement-breakpoint
CREATE TABLE "segmentations" (
	"id" serial PRIMARY KEY NOT NULL,
	"image_id" text NOT NULL,
	"noun_phrase" text NOT NULL,
	"found" boolean NOT NULL,
	"instances" integer NOT NULL,
	"box" jsonb,
	"score" real,
	"mask_svg_path" text,
	"object_crop_id" text,
	"context_crop_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "spend" (
	"day" text PRIMARY KEY NOT NULL,
	"usd" real DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "staff_decisions" (
	"id" serial PRIMARY KEY NOT NULL,
	"report_id" text NOT NULL,
	"analysis_id" integer,
	"suggested" text NOT NULL,
	"final_action" text NOT NULL,
	"incident_id" text,
	"agreed" boolean NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX "agent_runs_report" ON "agent_runs" USING btree ("report_id");--> statement-breakpoint
CREATE INDEX "images_report" ON "images" USING btree ("report_id");--> statement-breakpoint
CREATE INDEX "incident_events_incident" ON "incident_events" USING btree ("incident_id");--> statement-breakpoint
CREATE INDEX "report_analyses_report" ON "report_analyses" USING btree ("report_id");--> statement-breakpoint
CREATE INDEX "reports_incident" ON "reports" USING btree ("incident_id");--> statement-breakpoint
CREATE INDEX "segmentations_image" ON "segmentations" USING btree ("image_id");