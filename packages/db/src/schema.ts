import {
  bigint,
  index,
  pgEnum,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";

export const snippetKind = pgEnum("snippet_kind", ["text", "link", "file", "image"]);
export const storageProvider = pgEnum("storage_provider", ["googleDrive", "oneDrive", "dropbox"]);
export const uploadKind = pgEnum("upload_kind", ["file", "image"]);

const timestamps = {
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
};

export const storageConnections = pgTable(
  "storage_connections",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    ownerWorkosUserId: text("owner_workos_user_id").notNull(),
    provider: storageProvider("provider").notNull(),
    providerAccountId: text("provider_account_id"),
    providerRootId: text("provider_root_id"),
    ...timestamps,
  },
  (table) => [
    uniqueIndex("storage_connections_owner_provider_unique").on(
      table.ownerWorkosUserId,
      table.provider,
    ),
  ],
);

export const snippetUploads = pgTable(
  "snippet_uploads",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    ownerWorkosUserId: text("owner_workos_user_id").notNull(),
    kind: uploadKind("kind").notNull(),
    storageConnectionId: uuid("storage_connection_id")
      .notNull()
      .references(() => storageConnections.id, { onDelete: "cascade" }),
    objectKey: text("object_key").notNull(),
    fileName: text("file_name").notNull(),
    byteSize: bigint("byte_size", { mode: "number" }).notNull(),
    contentType: text("content_type"),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    completedAt: timestamp("completed_at", { withTimezone: true }),
    ...timestamps,
  },
  (table) => [
    index("snippet_uploads_owner_created_at_idx").on(table.ownerWorkosUserId, table.createdAt),
    uniqueIndex("snippet_uploads_object_key_unique").on(table.storageConnectionId, table.objectKey),
  ],
);

export const snippets = pgTable(
  "snippets",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    ownerWorkosUserId: text("owner_workos_user_id").notNull(),
    kind: snippetKind("kind").notNull(),
    title: text("title").notNull(),
    textContent: text("text_content"),
    url: text("url"),
    storageConnectionId: uuid("storage_connection_id").references(() => storageConnections.id, {
      onDelete: "set null",
    }),
    uploadId: uuid("upload_id").references(() => snippetUploads.id, { onDelete: "set null" }),
    objectKey: text("object_key"),
    fileName: text("file_name"),
    byteSize: bigint("byte_size", { mode: "number" }),
    contentType: text("content_type"),
    deletedAt: timestamp("deleted_at", { withTimezone: true }),
    ...timestamps,
  },
  (table) => [
    index("snippets_owner_created_at_idx").on(table.ownerWorkosUserId, table.createdAt),
    index("snippets_owner_kind_idx").on(table.ownerWorkosUserId, table.kind),
  ],
);
