CREATE TYPE "snippet_change_type" AS ENUM('UPSERT', 'DELETE');--> statement-breakpoint
ALTER TYPE "snippet_upload_status" ADD VALUE 'INTERRUPTED' BEFORE 'READY';--> statement-breakpoint
CREATE TABLE "snippet_change_feeds" (
	"owner_workos_user_id" text PRIMARY KEY,
	"latest_sequence" bigint DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "snippet_changes" (
	"owner_workos_user_id" text,
	"sequence" bigint,
	"change_type" "snippet_change_type" NOT NULL,
	"snippet_id" uuid NOT NULL,
	"snapshot" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "snippet_changes_pkey" PRIMARY KEY("owner_workos_user_id","sequence"),
	CONSTRAINT "snippet_changes_snapshot_type_check" CHECK (("change_type" = 'UPSERT') = ("snapshot" is not null))
);
--> statement-breakpoint
CREATE FUNCTION notify_snippet_change() RETURNS trigger AS $$
BEGIN
	PERFORM pg_notify('snippet_changes', NEW.owner_workos_user_id);
	RETURN NEW;
END;
$$ LANGUAGE plpgsql;--> statement-breakpoint
CREATE TRIGGER "snippet_changes_notify"
	AFTER INSERT ON "snippet_changes"
	FOR EACH ROW EXECUTE FUNCTION notify_snippet_change();
