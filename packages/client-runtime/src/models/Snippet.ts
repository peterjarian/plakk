import { LocalContentAvailabilitySchema, StorageProviderLiteral } from "@plakk/shared";
import { SnippetIdSchema } from "@plakk/shared/PlakkApi";
import * as Schema from "effect/Schema";

const SnippetFields = {
  id: SnippetIdSchema,
  fileName: Schema.String,
  title: Schema.optionalKey(Schema.String),
  byteSize: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  storageProvider: StorageProviderLiteral,
  mediaType: Schema.NullOr(Schema.String),
  createdAt: Schema.String,
  updatedAt: Schema.String,
  localContentAvailability: LocalContentAvailabilitySchema,
};

/**
 * The single SQLite-backed local snippet model used by the client.
 *
 * A snippet exists locally before it reaches the backend. Its status records
 * whether it is preparing, uploading, failed locally, or published.
 */
export const SnippetSchema = Schema.Union([
  Schema.Struct({
    ...SnippetFields,
    status: Schema.Literal("PREPARING"),
    storageObjectId: Schema.Null,
    errorMessage: Schema.Null,
  }),
  Schema.Struct({
    ...SnippetFields,
    status: Schema.Literal("UPLOADING"),
    storageObjectId: Schema.Null,
    errorMessage: Schema.Null,
  }),
  Schema.Struct({
    ...SnippetFields,
    status: Schema.Literal("FAILED"),
    storageObjectId: Schema.Null,
    errorMessage: Schema.String,
  }),
  Schema.Struct({
    ...SnippetFields,
    status: Schema.Literal("PUBLISHED"),
    storageObjectId: Schema.String,
    errorMessage: Schema.Null,
  }),
]);

export type Snippet = typeof SnippetSchema.Type;
export type PublishedSnippet = Extract<Snippet, { readonly status: "PUBLISHED" }>;

/** Returns whether a local snippet has an authoritative backend record. */
export const isPublishedSnippet = (snippet: Snippet): snippet is PublishedSnippet =>
  snippet.status === "PUBLISHED";
