CREATE TABLE "briefs" (
	"id" serial PRIMARY KEY NOT NULL,
	"report_id" text NOT NULL,
	"analysis_id" integer NOT NULL,
	"requested_by" text DEFAULT 'staff' NOT NULL,
	"status" text NOT NULL,
	"steps" jsonb NOT NULL,
	"facts" jsonb NOT NULL,
	"brief" jsonb,
	"dropped" integer DEFAULT 0 NOT NULL,
	"error" text,
	"cost_usd" real NOT NULL,
	"latency_ms" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX "briefs_report" ON "briefs" USING btree ("report_id");