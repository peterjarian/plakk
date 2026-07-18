import {
  ApiSnippetSchema,
  SnippetChangeCursorSchema,
  type ApiSnippet,
} from "@plakk/shared/PlakkApi";
import { Context, type Effect, Schema, type Stream } from "effect";

export const SnippetReplicaStateSchema = Schema.Struct({
  cursor: SnippetChangeCursorSchema,
  items: Schema.Array(ApiSnippetSchema),
});

export type SnippetReplicaState = typeof SnippetReplicaStateSchema.Type;

export class SnippetReplicaError extends Schema.TaggedErrorClass<SnippetReplicaError>()(
  "SnippetReplicaError",
  { cause: Schema.Defect(), reason: Schema.String },
) {}

export class SnippetRecoveryCleanupError extends Schema.TaggedErrorClass<SnippetRecoveryCleanupError>()(
  "SnippetRecoveryCleanupError",
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
      deletedIds?: ReadonlyArray<string>,
    ): Effect.Effect<void, SnippetReplicaError | SnippetRecoveryCleanupError>;
    purge(accountId: string): Effect.Effect<void, SnippetReplicaError>;
    remove(accountId: string, snippetId: string): Effect.Effect<void, SnippetReplicaError>;
  }
>()("plakk/main/snippets/replica/SnippetReplica") {}
