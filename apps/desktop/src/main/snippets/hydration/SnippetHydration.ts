import type { LocalContentAvailability } from "@plakk/shared";
import type { SnippetReplicaError } from "../replica/SnippetReplica.ts";
import type { ManagedSnippetContentError } from "../content/ManagedSnippetContent.ts";
import type { SnippetSyncAccount } from "../replica/SnippetRemoteTransport.ts";
import { Context, Schema } from "effect";
import type { Effect, Stream } from "effect";

export class SnippetHydrationError extends Schema.TaggedErrorClass<SnippetHydrationError>()(
  "SnippetHydrationError",
  {
    cause: Schema.Defect(),
    reason: Schema.String,
    retryable: Schema.Boolean,
  },
) {}

export type SnippetHydrationEngineFailure =
  | SnippetHydrationError
  | ManagedSnippetContentError
  | SnippetReplicaError;

export interface SnippetHydrationShape {
  readonly changes: Stream.Stream<string>;
  readonly resume: (
    account: SnippetSyncAccount,
  ) => Effect.Effect<void, SnippetHydrationEngineFailure>;
  readonly pause: Effect.Effect<void>;
  readonly purge: (accountId: string) => Effect.Effect<void>;
  readonly reconcile: (
    accountId: string,
  ) => Effect.Effect<ReadonlyMap<string, LocalContentAvailability>, SnippetHydrationEngineFailure>;
  readonly download: (
    account: SnippetSyncAccount,
    snippetId: string,
  ) => Effect.Effect<void, SnippetHydrationEngineFailure>;
  readonly freeUpSpace: (accountId: string) => Effect.Effect<void, SnippetHydrationEngineFailure>;
  readonly state: (
    accountId: string,
    snippetId: string,
    byteSize: number,
  ) => Effect.Effect<LocalContentAvailability, ManagedSnippetContentError>;
}

export class SnippetHydrationEngine extends Context.Service<
  SnippetHydrationEngine,
  SnippetHydrationShape
>()("plakk/main/snippets/hydration/SnippetHydration") {}
