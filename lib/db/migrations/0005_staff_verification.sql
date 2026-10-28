ALTER TABLE "agent_runs" ADD COLUMN "requested_by" text DEFAULT 'pipeline' NOT NULL;--> statement-breakpoint
ALTER TABLE "agent_runs" ADD COLUMN "applied" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "report_analyses" ADD COLUMN "input" jsonb;--> statement-breakpoint
ALTER TABLE "report_analyses" ADD COLUMN "after_fix" jsonb;--> statement-breakpoint
ALTER TABLE "reports" ADD COLUMN "verify_claimed_at" timestamp with time zone;