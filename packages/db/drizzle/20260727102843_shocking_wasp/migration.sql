CREATE TYPE "billing_authority_status" AS ENUM('NONE', 'PAID', 'PAST_DUE');--> statement-breakpoint
CREATE TABLE "account_billing_states" (
	"workos_user_id" text PRIMARY KEY,
	"authority_status" "billing_authority_status" NOT NULL,
	"paid_through" timestamp with time zone,
	"cancel_at_period_end" boolean DEFAULT false NOT NULL,
	"grace_started_at" timestamp with time zone,
	"grace_ends_at" timestamp with time zone,
	"ever_paid_at" timestamp with time zone,
	"authority_updated_at" timestamp with time zone NOT NULL,
	"reconciled_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "account_billing_paid_has_period" CHECK ("authority_status" <> 'PAID' OR "paid_through" IS NOT NULL),
	CONSTRAINT "account_billing_grace_is_complete" CHECK (("grace_started_at" IS NULL) = ("grace_ends_at" IS NULL)),
	CONSTRAINT "account_billing_past_due_has_grace" CHECK ("authority_status" <> 'PAST_DUE' OR "grace_ends_at" IS NOT NULL)
);
