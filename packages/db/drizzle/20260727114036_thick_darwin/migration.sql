CREATE TABLE "storage_authorization_intents" (
	"workos_user_id" text PRIMARY KEY,
	"storage_provider" "storage_provider" NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
