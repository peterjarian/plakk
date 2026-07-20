import { ApiSnippetSchema, type ApiSnippet } from "@plakk/shared/PlakkApi";
import { Context, type Effect, Schema, type Stream } from "effect";

export const SnippetReplicaStateSchema = Schema.Struct({
  items: Schema.Array(ApiSnippetSchema),
});

export type SnippetReplicaState = typeof SnippetReplicaStateSchema.Type;

export class SnippetReplicaError extends Schema.TaggedErrorClass<SnippetReplicaError>()(
  "SnippetReplicaError",
  { cause: Schema.Defect(), reason: Schema.String },
) {}

export class SnippetPublishedCleanupError extends Schema.TaggedErrorClass<SnippetPublishedCleanupError>()(
  "SnippetPublishedCleanupError",
  { cause: Schema.Defect(), reason: Schema.String },
) {}

export class SnippetReplica extends Context.Service<
  SnippetReplica,
  {
    readonly changes: Stream.Stream<{
      readonly accountId: string;
      readonly items: ReadonlyArray<ApiSnippet>;
    }>;
    get(accountId: string): Effect.Effect<SnippetReplicaState | null, SnippetReplicaError>;
    commit(
      accountId: string,
      state: SnippetReplicaState,
      removedPublishedIds?: ReadonlyArray<string>,
    ): Effect.Effect<void, SnippetReplicaError | SnippetPublishedCleanupError>;
    purge(accountId: string): Effect.Effect<void, SnippetReplicaError>;
    remove(accountId: string, snippetId: string): Effect.Effect<void, SnippetReplicaError>;
  }
>()("plakk/main/snippets/replica/SnippetReplica") {}
