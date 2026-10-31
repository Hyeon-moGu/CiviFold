ALTER TABLE "images" ALTER COLUMN "storage_path" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "images" ADD COLUMN "bytes" "bytea";