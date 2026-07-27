CREATE TYPE "storage_cleanup_action" AS ENUM('UNLINK', 'SWITCH');--> statement-breakpoint
CREATE TABLE "storage_cleanup_intents" (
	"workos_user_id" text PRIMARY KEY,
	"storage_provider" "storage_provider" NOT NULL,
	"action" "storage_cleanup_action" NOT NULL,
	"total_snippet_count" bigint NOT NULL,
	"attempt_id" uuid,
	"lease_expires_at" timestamp with time zone,
	"last_failure" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "storage_cleanup_total_nonnegative" CHECK ("total_snippet_count" >= 0),
	CONSTRAINT "storage_cleanup_lease_is_complete" CHECK (("attempt_id" IS NULL) = ("lease_expires_at" IS NULL))
);
