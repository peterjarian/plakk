import { STORAGE_PROVIDERS } from "@plakk/shared";
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
