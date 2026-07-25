import type { ApiSnippet } from "@plakk/shared/PlakkApi";
import type { RpcError } from "@plakk/shared/RpcError";
import { Context, type Effect, Schema, type Stream } from "effect";
import type { RpcClientError } from "effect/unstable/rpc/RpcClientError";

export type SnippetSyncAccount = {
  readonly id: string;
  readonly accessToken: string;
};

export class SnippetRemoteTransportError extends Schema.TaggedErrorClass<SnippetRemoteTransportError>()(
  "SnippetRemoteTransportError",
  { cause: Schema.Defect(), reason: Schema.String },
) {}

export type SnippetRemoteError = RpcError | RpcClientError | SnippetRemoteTransportError;

export class SnippetRemoteTransport extends Context.Service<
  SnippetRemoteTransport,
  {
    snapshot(
      account: SnippetSyncAccount,
    ): Effect.Effect<ReadonlyArray<ApiSnippet>, SnippetRemoteError>;
    invalidations(account: SnippetSyncAccount): Stream.Stream<void, SnippetRemoteError>;
  }
>()("plakk/main/snippets/replica/SnippetRemoteTransport") {}
