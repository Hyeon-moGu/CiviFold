ALTER TABLE "report_analyses" ALTER COLUMN "triage" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "report_analyses" ADD COLUMN "intake" jsonb;--> statement-breakpoint
ALTER TABLE "reports" ADD COLUMN "channel" text DEFAULT 'photo' NOT NULL;--> statement-breakpoint
ALTER TABLE "reports" ADD COLUMN "audio_path" text;--> statement-breakpoint
ALTER TABLE "reports" ADD COLUMN "transcript" text;--> statement-breakpoint
ALTER TABLE "reports" ADD COLUMN "urgent" boolean DEFAULT false NOT NULL;