import { STORAGE_PROVIDERS } from "@plakk/shared";
import {
  bigint,
  boolean,
  check,
  index,
  pgEnum,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";

export const storageProvider = pgEnum("storage_provider", STORAGE_PROVIDERS);
export const billingAuthorityStatus = pgEnum("billing_authority_status", [
  "NONE",
  "PAID",
  "PAST_DUE",
]);
export const storageCleanupAction = pgEnum("storage_cleanup_action", ["UNLINK", "SWITCH"]);

const timestamps = {
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
};

export const accountTrials = pgTable(
  "account_trials",
  {
    workosUserId: text("workos_user_id").primaryKey(),
    startedAt: timestamp("started_at", { withTimezone: true }).notNull(),
    endsAt: timestamp("ends_at", { withTimezone: true }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    check(
      "account_trials_exact_duration",
      sql`extract(epoch from (${table.endsAt} - ${table.startedAt})) = 1209600`,
    ),
  ],
);

export type AccountTrialRow = typeof accountTrials.$inferSelect;

export const accountBillingStates = pgTable(
  "account_billing_states",
  {
    workosUserId: text("workos_user_id").primaryKey(),
    authorityStatus: billingAuthorityStatus("authority_status").notNull(),
    paidThrough: timestamp("paid_through", { withTimezone: true }),
    cancelAtPeriodEnd: boolean("cancel_at_period_end").default(false).notNull(),
    graceStartedAt: timestamp("grace_started_at", { withTimezone: true }),
    graceEndsAt: timestamp("grace_ends_at", { withTimezone: true }),
    everPaidAt: timestamp("ever_paid_at", { withTimezone: true }),
    authorityUpdatedAt: timestamp("authority_updated_at", { withTimezone: true }).notNull(),
    reconciledAt: timestamp("reconciled_at", { withTimezone: true }).notNull(),
    ...timestamps,
  },
  (table) => [
    check(
      "account_billing_paid_has_period",
      sql`${table.authorityStatus} <> 'PAID' OR ${table.paidThrough} IS NOT NULL`,
    ),
    check(
      "account_billing_grace_is_complete",
      sql`(${table.graceStartedAt} IS NULL) = (${table.graceEndsAt} IS NULL)`,
    ),
    check(
      "account_billing_past_due_has_grace",
      sql`${table.authorityStatus} <> 'PAST_DUE' OR ${table.graceEndsAt} IS NOT NULL`,
    ),
  ],
);

export type AccountBillingStateRow = typeof accountBillingStates.$inferSelect;

export const storageAuthorizationIntents = pgTable("storage_authorization_intents", {
  workosUserId: text("workos_user_id").primaryKey(),
  storageProvider: storageProvider("storage_provider").notNull(),
  ...timestamps,
});

export type StorageAuthorizationIntentRow = typeof storageAuthorizationIntents.$inferSelect;

export const storageCleanupIntents = pgTable(
  "storage_cleanup_intents",
  {
    workosUserId: text("workos_user_id").primaryKey(),
    storageProvider: storageProvider("storage_provider").notNull(),
    action: storageCleanupAction("action").notNull(),
    totalSnippetCount: bigint("total_snippet_count", { mode: "number" }).notNull(),
    attemptId: uuid("attempt_id"),
    leaseExpiresAt: timestamp("lease_expires_at", { withTimezone: true }),
    lastFailure: text("last_failure"),
    ...timestamps,
  },
  (table) => [
    check("storage_cleanup_total_nonnegative", sql`${table.totalSnippetCount} >= 0`),
    check(
      "storage_cleanup_lease_is_complete",
      sql`(${table.attemptId} IS NULL) = (${table.leaseExpiresAt} IS NULL)`,
    ),
  ],
);

export type StorageCleanupIntentRow = typeof storageCleanupIntents.$inferSelect;

export const snippets = pgTable(
  "snippets",
  {
    id: uuid("id").primaryKey(),
    ownerWorkosUserId: text("owner_workos_user_id").notNull(),
    storageProvider: storageProvider("storage_provider").notNull(),
    storageObjectId: text("storage_object_id").notNull(),
    fileName: text("file_name").notNull(),
    byteSize: bigint("byte_size", { mode: "number" }).notNull(),
    ...timestamps,
  },
  (table) => [
    index("snippets_owner_created_at_idx").on(table.ownerWorkosUserId, table.createdAt),
    uniqueIndex("snippets_owner_storage_object_unique").on(
      table.ownerWorkosUserId,
      table.storageProvider,
      table.storageObjectId,
    ),
  ],
);

export type SnippetRow = typeof snippets.$inferSelect;
