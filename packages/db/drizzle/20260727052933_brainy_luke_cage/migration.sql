CREATE TABLE "account_trials" (
	"workos_user_id" text PRIMARY KEY,
	"started_at" timestamp with time zone NOT NULL,
	"ends_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "account_trials_exact_duration" CHECK (extract(epoch from ("ends_at" - "started_at")) = 1209600)
);
