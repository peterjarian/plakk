import {
  DeviceSnippetRecordSchema,
  deviceSnippetRecordId,
  type DeviceSnippetRecord,
  type LocalUploadRecord,
  type PublishedSnippetRecord,
} from "@plakk/shared";
import { Context, type Effect, Schema, type Stream } from "effect";

export {
  DeviceSnippetRecordSchema,
  deviceSnippetRecordId,
  type DeviceSnippetRecord,
  type LocalUploadRecord,
  type PublishedSnippetRecord,
};

export const SnippetReplicaStateSchema = Schema.Struct({
  items: Schema.Array(DeviceSnippetRecordSchema),
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
