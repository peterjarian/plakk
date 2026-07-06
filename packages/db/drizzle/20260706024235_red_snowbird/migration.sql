CREATE TYPE "snippet_kind" AS ENUM('TEXT', 'LINK', 'FILE', 'IMAGE');--> statement-breakpoint
CREATE TYPE "storage_provider" AS ENUM('googleDrive', 'oneDrive', 'dropbox');--> statement-breakpoint
CREATE TABLE "snippets" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"owner_workos_user_id" text NOT NULL,
	"kind" "snippet_kind" NOT NULL,
	"title" text NOT NULL,
	"storage_provider" "storage_provider" NOT NULL,
	"storage_object_id" text NOT NULL,
	"file_name" text NOT NULL,
	"byte_size" bigint NOT NULL,
	"content_type" text,
	"deleted_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX "snippets_owner_created_at_idx" ON "snippets" ("owner_workos_user_id","created_at");--> statement-breakpoint
CREATE INDEX "snippets_owner_kind_idx" ON "snippets" ("owner_workos_user_id","kind");--> statement-breakpoint
CREATE UNIQUE INDEX "snippets_owner_storage_object_unique" ON "snippets" ("owner_workos_user_id","storage_provider","storage_object_id");