import type {
  ApiSnippet,
  CreateStoredSnippetPayload,
  PreparedStorageUpload,
} from "@plakk/shared/PlakkApi";
import type { RpcError } from "@plakk/shared/RpcError";
import { Context, Effect, Layer } from "effect";
import type { RpcClientError } from "effect/unstable/rpc/RpcClientError";

import { makePlakkClient } from "./accountStatus.ts";

const headers = (accessToken: string) => ({ authorization: `Bearer ${accessToken}` });
type SnippetUploadRemoteError = RpcError | RpcClientError;

export class SnippetUploadRemote extends Context.Service<
  SnippetUploadRemote,
  {
    create(
      accessToken: string,
      input: CreateStoredSnippetPayload,
    ): Effect.Effect<ApiSnippet, SnippetUploadRemoteError>;
    prepare(
      accessToken: string,
      input: { readonly snippetId: string; readonly mediaType: string | null },
    ): Effect.Effect<PreparedStorageUpload, SnippetUploadRemoteError>;
    heartbeat(
      accessToken: string,
      id: string,
    ): Effect.Effect<{ readonly expiresAt: string }, SnippetUploadRemoteError>;
    fail(accessToken: string, id: string): Effect.Effect<ApiSnippet, SnippetUploadRemoteError>;
    retry(accessToken: string, id: string): Effect.Effect<ApiSnippet, SnippetUploadRemoteError>;
    complete(
      accessToken: string,
      input: { readonly id: string; readonly storageObjectId: string },
    ): Effect.Effect<ApiSnippet, SnippetUploadRemoteError>;
    delete(accessToken: string, id: string): Effect.Effect<void, SnippetUploadRemoteError>;
  }
>()("plakk/main/SnippetUploadRemote") {
  static readonly Live = Layer.effect(
    SnippetUploadRemote,
    Effect.gen(function* () {
      const client = yield* makePlakkClient;
      return SnippetUploadRemote.of({
        create: Effect.fn("SnippetUploadRemote.create")((accessToken, input) =>
          client.CreateStoredSnippet(input, { headers: headers(accessToken) }),
        ),
        prepare: Effect.fn("SnippetUploadRemote.prepare")((accessToken, input) =>
          client.PrepareStoredSnippetUpload(input, { headers: headers(accessToken) }),
        ),
        heartbeat: Effect.fn("SnippetUploadRemote.heartbeat")((accessToken, id) =>
          client.HeartbeatStoredSnippetUpload({ id }, { headers: headers(accessToken) }),
        ),
        fail: Effect.fn("SnippetUploadRemote.fail")((accessToken, id) =>
          client.FailStoredSnippetUpload({ id }, { headers: headers(accessToken) }),
        ),
        retry: Effect.fn("SnippetUploadRemote.retry")((accessToken, id) =>
          client.RetryStoredSnippetUpload({ id }, { headers: headers(accessToken) }),
        ),
        complete: Effect.fn("SnippetUploadRemote.complete")((accessToken, input) =>
          client.CompleteStoredSnippetUpload(input, { headers: headers(accessToken) }),
        ),
        delete: Effect.fn("SnippetUploadRemote.delete")((accessToken, id) =>
          client.DeleteSnippet({ id }, { headers: headers(accessToken) }),
        ),
      });
    }),
  );
}
