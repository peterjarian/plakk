DELETE FROM "snippets" WHERE "deleted_at" IS NOT NULL;--> statement-breakpoint
ALTER TABLE "snippets" DROP COLUMN "deleted_at";
