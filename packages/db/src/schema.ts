import { SNIPPET_KINDS, SNIPPET_UPLOAD_STATUSES, STORAGE_PROVIDERS } from "@plakk/shared";
import type { ApiSnippet, PreparedStorageUpload } from "@plakk/shared/PlakkApi";
import { sql } from "drizzle-orm";
import {
  bigint,
  check,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";

export const snippetKind = pgEnum("snippet_kind", SNIPPET_KINDS);
export const snippetUploadStatus = pgEnum("snippet_upload_status", SNIPPET_UPLOAD_STATUSES);
export const snippetChangeType = pgEnum("snippet_change_type", ["UPSERT", "DELETE"]);
export const storageProvider = pgEnum("storage_provider", STORAGE_PROVIDERS);

const timestamps = {
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
};

export const snippets = pgTable(
  "snippets",
  {
    id: uuid("id").primaryKey(),
    ownerWorkosUserId: text("owner_workos_user_id").notNull(),
    kind: snippetKind("kind").notNull(),
    title: text("title").notNull(),
    storageProvider: storageProvider("storage_provider"),
    storageObjectId: text("storage_object_id"),
    clientMutationId: uuid("client_mutation_id"),
    uploadStatus: snippetUploadStatus("upload_status").default("READY").notNull(),
    uploadLeaseId: uuid("upload_lease_id"),
    uploadLeaseExpiresAt: timestamp("upload_lease_expires_at", { withTimezone: true }),
    uploadPreparationGeneration: integer("upload_preparation_generation"),
    uploadPreparation: jsonb("upload_preparation").$type<PreparedStorageUpload>(),
    uploadFailureMessage: text("upload_failure_message"),
    fileName: text("file_name").notNull(),
    byteSize: bigint("byte_size", { mode: "number" }).notNull(),
    contentType: text("content_type"),
    deletedAt: timestamp("deleted_at", { withTimezone: true }),
    ...timestamps,
  },
  (table) => [
    index("snippets_owner_created_at_idx").on(table.ownerWorkosUserId, table.createdAt),
    index("snippets_owner_kind_idx").on(table.ownerWorkosUserId, table.kind),
    uniqueIndex("snippets_owner_storage_object_unique").on(
      table.ownerWorkosUserId,
      table.storageProvider,
      table.storageObjectId,
    ),
    uniqueIndex("snippets_owner_client_mutation_unique").on(
      table.ownerWorkosUserId,
      table.clientMutationId,
    ),
  ],
);

export type SnippetRow = typeof snippets.$inferSelect;

export const snippetChangeFeeds = pgTable("snippet_change_feeds", {
  ownerWorkosUserId: text("owner_workos_user_id").primaryKey(),
  latestSequence: bigint("latest_sequence", { mode: "bigint" }).default(0n).notNull(),
});

export const snippetChanges = pgTable(
  "snippet_changes",
  {
    ownerWorkosUserId: text("owner_workos_user_id").notNull(),
    sequence: bigint("sequence", { mode: "bigint" }).notNull(),
    changeType: snippetChangeType("change_type").notNull(),
    snippetId: uuid("snippet_id").notNull(),
    snapshot: jsonb("snapshot").$type<ApiSnippet>(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.ownerWorkosUserId, table.sequence] }),
    check(
      "snippet_changes_snapshot_type_check",
      sql`(${table.changeType} = 'UPSERT') = (${table.snapshot} is not null)`,
    ),
  ],
);

export type SnippetChangeRow = typeof snippetChanges.$inferSelect;
