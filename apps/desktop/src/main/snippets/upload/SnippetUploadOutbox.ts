import { SnippetUploadStatusLiteral, StorageProviderLiteral } from "@plakk/shared";
import { SnippetIdSchema } from "@plakk/shared/PlakkApi";
import { Context, type Effect, Schema } from "effect";

export const SnippetUploadOutboxEntrySchema = Schema.Struct({
  id: SnippetIdSchema,
  fileName: Schema.String,
  byteSize: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  mediaType: Schema.NullOr(Schema.String),
  storageProvider: StorageProviderLiteral,
  phase: Schema.Literals(["QUEUED", "UPLOADING", "FAILED", "UPLOADED"] as const),
  progress: Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 100 })),
  storageObjectId: Schema.NullOr(Schema.String),
  authoritativeStatus: Schema.NullOr(SnippetUploadStatusLiteral),
  errorMessage: Schema.NullOr(Schema.String),
  canRetry: Schema.Boolean,
  createdAt: Schema.String,
  updatedAt: Schema.String,
});

export type SnippetUploadOutboxEntry = typeof SnippetUploadOutboxEntrySchema.Type;

export class SnippetUploadOutboxError extends Schema.TaggedErrorClass<SnippetUploadOutboxError>()(
  "SnippetUploadOutboxError",
  {
    cause: Schema.Defect(),
    reason: Schema.String,
  },
) {}

export class SnippetUploadOutbox extends Context.Service<
  SnippetUploadOutbox,
  {
    list(
      accountId: string,
    ): Effect.Effect<ReadonlyArray<SnippetUploadOutboxEntry>, SnippetUploadOutboxError>;
    get(
      accountId: string,
      snippetId: string,
    ): Effect.Effect<SnippetUploadOutboxEntry | null, SnippetUploadOutboxError>;
    put(
      accountId: string,
      entry: SnippetUploadOutboxEntry,
    ): Effect.Effect<void, SnippetUploadOutboxError>;
    remove(accountId: string, snippetId: string): Effect.Effect<void, SnippetUploadOutboxError>;
    purge(accountId: string): Effect.Effect<void, SnippetUploadOutboxError>;
  }
>()("plakk/main/snippets/upload/SnippetUploadOutbox") {}
