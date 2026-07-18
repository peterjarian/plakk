import type { LocalContentAvailability } from "@plakk/shared";
import type { ApiSnippet } from "@plakk/shared/PlakkApi";
import type {
  ManagedSnippetContentError,
  SnippetReplicaError,
  SnippetSyncAccount,
} from "@plakk/shared/SnippetReplica";
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

export interface SnippetHydrationTransportShape {
  readonly stream: (
    account: SnippetSyncAccount,
    snippet: ApiSnippet,
  ) => Stream.Stream<Uint8Array, SnippetHydrationError>;
}

export class SnippetHydrationTransport extends Context.Service<
  SnippetHydrationTransport,
  SnippetHydrationTransportShape
>()("plakk/main/Services/SnippetHydrationTransport") {}

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
  readonly state: (
    accountId: string,
    snippetId: string,
    byteSize: number,
  ) => Effect.Effect<LocalContentAvailability, ManagedSnippetContentError>;
}

export class SnippetHydrationEngine extends Context.Service<
  SnippetHydrationEngine,
  SnippetHydrationShape
>()("plakk/main/Services/SnippetHydrationEngine") {}
