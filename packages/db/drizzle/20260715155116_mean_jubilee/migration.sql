CREATE TYPE "storage_provider" AS ENUM('GOOGLE_DRIVE', 'ONE_DRIVE', 'DROPBOX');--> statement-breakpoint
CREATE TYPE "snippet_upload_status" AS ENUM('UPLOADING', 'FAILED', 'UPLOADED');--> statement-breakpoint
CREATE TYPE "snippet_change_type" AS ENUM('UPSERT', 'DELETE');--> statement-breakpoint
CREATE TABLE "snippets" (
	"id" uuid PRIMARY KEY,
	"owner_workos_user_id" text NOT NULL,
	"storage_provider" "storage_provider" NOT NULL,
	"storage_object_id" text,
	"upload_status" "snippet_upload_status" NOT NULL,
	"upload_heartbeat_expires_at" timestamp with time zone,
	"file_name" text NOT NULL,
	"byte_size" bigint NOT NULL,
	"deleted_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "snippet_change_feeds" (
	"owner_workos_user_id" text PRIMARY KEY,
	"latest_sequence" bigint DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "snippet_changes" (
	"owner_workos_user_id" text NOT NULL,
	"sequence" bigint NOT NULL,
	"change_type" "snippet_change_type" NOT NULL,
	"snippet_id" uuid NOT NULL,
	"snapshot" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "snippet_changes_pkey" PRIMARY KEY("owner_workos_user_id","sequence"),
	CONSTRAINT "snippet_changes_snapshot_type_check" CHECK (("change_type" = 'UPSERT') = ("snapshot" is not null))
);
--> statement-breakpoint
CREATE INDEX "snippets_owner_created_at_idx" ON "snippets" ("owner_workos_user_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "snippets_owner_storage_object_unique" ON "snippets" ("owner_workos_user_id","storage_provider","storage_object_id");--> statement-breakpoint
CREATE FUNCTION notify_snippet_change() RETURNS trigger AS $$
BEGIN
	PERFORM pg_notify('snippet_changes', NEW.owner_workos_user_id);
	RETURN NEW;
END;
$$ LANGUAGE plpgsql;--> statement-breakpoint
CREATE TRIGGER "snippet_changes_notify"
	AFTER INSERT ON "snippet_changes"
	FOR EACH ROW EXECUTE FUNCTION notify_snippet_change();
