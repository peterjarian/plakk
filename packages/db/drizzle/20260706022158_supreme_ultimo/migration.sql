CREATE TYPE "snippet_kind" AS ENUM('text', 'link', 'file', 'image');--> statement-breakpoint
CREATE TYPE "storage_provider" AS ENUM('googleDrive', 'oneDrive', 'dropbox');--> statement-breakpoint
CREATE TYPE "upload_kind" AS ENUM('file', 'image');--> statement-breakpoint
CREATE TABLE "snippet_uploads" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"owner_workos_user_id" text NOT NULL,
	"kind" "upload_kind" NOT NULL,
	"storage_connection_id" uuid NOT NULL,
	"object_key" text NOT NULL,
	"file_name" text NOT NULL,
	"byte_size" bigint NOT NULL,
	"content_type" text,
	"expires_at" timestamp with time zone NOT NULL,
	"completed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "snippets" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"owner_workos_user_id" text NOT NULL,
	"kind" "snippet_kind" NOT NULL,
	"title" text NOT NULL,
	"text_content" text,
	"url" text,
	"storage_connection_id" uuid,
	"upload_id" uuid,
	"object_key" text,
	"file_name" text,
	"byte_size" bigint,
	"content_type" text,
	"deleted_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "storage_connections" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"owner_workos_user_id" text NOT NULL,
	"provider" "storage_provider" NOT NULL,
	"provider_account_id" text,
	"provider_root_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX "snippet_uploads_owner_created_at_idx" ON "snippet_uploads" ("owner_workos_user_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "snippet_uploads_object_key_unique" ON "snippet_uploads" ("storage_connection_id","object_key");--> statement-breakpoint
CREATE INDEX "snippets_owner_created_at_idx" ON "snippets" ("owner_workos_user_id","created_at");--> statement-breakpoint
CREATE INDEX "snippets_owner_kind_idx" ON "snippets" ("owner_workos_user_id","kind");--> statement-breakpoint
CREATE UNIQUE INDEX "storage_connections_owner_provider_unique" ON "storage_connections" ("owner_workos_user_id","provider");--> statement-breakpoint
ALTER TABLE "snippet_uploads" ADD CONSTRAINT "snippet_uploads_ukSz6YE5WNhT_fkey" FOREIGN KEY ("storage_connection_id") REFERENCES "storage_connections"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "snippets" ADD CONSTRAINT "snippets_storage_connection_id_storage_connections_id_fkey" FOREIGN KEY ("storage_connection_id") REFERENCES "storage_connections"("id") ON DELETE SET NULL;--> statement-breakpoint
ALTER TABLE "snippets" ADD CONSTRAINT "snippets_upload_id_snippet_uploads_id_fkey" FOREIGN KEY ("upload_id") REFERENCES "snippet_uploads"("id") ON DELETE SET NULL;