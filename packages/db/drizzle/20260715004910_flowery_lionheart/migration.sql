ALTER TABLE "snippets" ADD COLUMN "client_mutation_id" uuid;--> statement-breakpoint
ALTER TABLE "snippets" ADD COLUMN "upload_lease_id" uuid;--> statement-breakpoint
ALTER TABLE "snippets" ADD COLUMN "upload_lease_expires_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "snippets" ADD COLUMN "upload_failure_message" text;--> statement-breakpoint
CREATE UNIQUE INDEX "snippets_owner_client_mutation_unique" ON "snippets" ("owner_workos_user_id","client_mutation_id");