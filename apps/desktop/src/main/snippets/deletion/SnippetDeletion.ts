import type { RpcError } from "@plakk/shared/RpcError";
import { Context, Effect, Layer, Schema } from "effect";
import type { RpcClientError } from "effect/unstable/rpc/RpcClientError";

import { PlakkRpcClient } from "../../PlakkRpcClient.ts";
import {
  ManagedSnippetContent,
  type ManagedSnippetContentError,
} from "../content/ManagedSnippetContent.ts";
import {
  deviceSnippetRecordId,
  SnippetReplica,
  type SnippetReplicaError,
} from "../replica/SnippetReplica.ts";

export type SnippetDeletionAccount = {
  readonly id: string;
  readonly accessToken: string | null;
};

export class SnippetDeletionError extends Schema.TaggedErrorClass<SnippetDeletionError>()(
  "SnippetDeletionError",
  { cause: Schema.Defect(), reason: Schema.String },
) {}

export type SnippetDeletionFailure =
  | SnippetDeletionError
  | ManagedSnippetContentError
  | SnippetReplicaError
  | RpcError
  | RpcClientError;

export class SnippetDeletion extends Context.Service<
  SnippetDeletion,
  {
    readonly delete: (
      account: SnippetDeletionAccount,
      snippetId: string,
    ) => Effect.Effect<void, SnippetDeletionFailure>;
  }
>()("plakk/main/snippets/deletion/SnippetDeletion") {}

const headers = (accessToken: string) => ({ authorization: `Bearer ${accessToken}` });

export const SnippetDeletionLive = Layer.effect(
  SnippetDeletion,
  Effect.gen(function* () {
    const client = yield* PlakkRpcClient;
    const content = yield* ManagedSnippetContent;
    const replica = yield* SnippetReplica;

    const deleteSnippet = Effect.fn("SnippetDeletion.delete")(function* (
      account: SnippetDeletionAccount,
      snippetId: string,
    ) {
      if (account.accessToken === null) {
        return yield* new SnippetDeletionError({
          cause: null,
          reason: "Reconnect before deleting this snippet.",
        });
      }
      const current = yield* replica.get(account.id);
      const record = current?.items.find((item) => deviceSnippetRecordId(item) === snippetId);
      if (record?.kind !== "PUBLISHED") return;

      yield* client.DeleteSnippet({ id: snippetId }, { headers: headers(account.accessToken) });
      yield* replica.remove(account.id, snippetId);
      yield* content.discard(account.id, snippetId);
    });

    return SnippetDeletion.of({ delete: deleteSnippet });
  }),
);
