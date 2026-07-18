import type { SnippetChangePage } from "@plakk/shared/PlakkApi";
import type { RpcError } from "@plakk/shared/RpcError";
import { Context, type Effect, type Stream } from "effect";
import type { RpcClientError } from "effect/unstable/rpc/RpcClientError";

import type { SnippetReplicaState } from "./SnippetReplica.ts";

export type SnippetSyncAccount = {
  readonly id: string;
  readonly accessToken: string;
};

export type SnippetRemoteError = RpcError | RpcClientError;

export class SnippetRemoteTransport extends Context.Service<
  SnippetRemoteTransport,
  {
    snapshot(account: SnippetSyncAccount): Effect.Effect<SnippetReplicaState, SnippetRemoteError>;
    pull(
      account: SnippetSyncAccount,
      cursor: string,
    ): Effect.Effect<SnippetChangePage, SnippetRemoteError>;
    wakes(account: SnippetSyncAccount): Stream.Stream<void, SnippetRemoteError>;
  }
>()("plakk/main/snippets/replica/SnippetRemoteTransport") {}
