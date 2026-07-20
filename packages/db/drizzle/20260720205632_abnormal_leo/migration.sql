ALTER TABLE "snippets" DROP COLUMN "upload_status";--> statement-breakpoint
ALTER TABLE "snippets" DROP COLUMN "upload_heartbeat_expires_at";--> statement-breakpoint
DELETE FROM "snippets" WHERE "storage_object_id" IS NULL;--> statement-breakpoint
ALTER TABLE "snippets" ALTER COLUMN "storage_object_id" SET NOT NULL;--> statement-breakpoint
DROP TYPE "snippet_upload_status";
