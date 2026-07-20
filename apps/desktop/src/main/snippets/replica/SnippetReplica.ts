import { StorageProviderLiteral } from "@plakk/shared";
import { ApiSnippetSchema, SnippetIdSchema } from "@plakk/shared/PlakkApi";
import { Context, type Effect, Schema, type Stream } from "effect";

export const LocalUploadRecordSchema = Schema.Struct({
  kind: Schema.Literal("LOCAL"),
  id: SnippetIdSchema,
  fileName: Schema.String,
  byteSize: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  storageProvider: StorageProviderLiteral,
  status: Schema.Literals(["UPLOADING", "FAILED"] as const),
  errorMessage: Schema.NullOr(Schema.String),
  createdAt: Schema.String,
  updatedAt: Schema.String,
});

export type LocalUploadRecord = typeof LocalUploadRecordSchema.Type;

export const PublishedSnippetRecordSchema = Schema.Struct({
  kind: Schema.Literal("PUBLISHED"),
  snippet: ApiSnippetSchema,
});

export type PublishedSnippetRecord = typeof PublishedSnippetRecordSchema.Type;
export type DeviceSnippetRecord = LocalUploadRecord | PublishedSnippetRecord;

export const deviceSnippetRecordId = (record: DeviceSnippetRecord) =>
  record.kind === "LOCAL" ? record.id : record.snippet.id;

export const SnippetReplicaStateSchema = Schema.Struct({
  items: Schema.Array(Schema.Union([LocalUploadRecordSchema, PublishedSnippetRecordSchema])),
});

export type SnippetReplicaState = typeof SnippetReplicaStateSchema.Type;

export class SnippetReplicaError extends Schema.TaggedErrorClass<SnippetReplicaError>()(
  "SnippetReplicaError",
  { cause: Schema.Defect(), reason: Schema.String },
) {}

export class SnippetReplica extends Context.Service<
  SnippetReplica,
  {
    readonly changes: Stream.Stream<{
      readonly accountId: string;
      readonly items: ReadonlyArray<DeviceSnippetRecord>;
    }>;
    get(accountId: string): Effect.Effect<SnippetReplicaState | null, SnippetReplicaError>;
    commit(accountId: string, state: SnippetReplicaState): Effect.Effect<void, SnippetReplicaError>;
    update(
      accountId: string,
      transform: (current: SnippetReplicaState) => SnippetReplicaState,
    ): Effect.Effect<SnippetReplicaState, SnippetReplicaError>;
    purge(accountId: string): Effect.Effect<void, SnippetReplicaError>;
    remove(accountId: string, snippetId: string): Effect.Effect<void, SnippetReplicaError>;
  }
>()("plakk/main/snippets/replica/SnippetReplica") {}
