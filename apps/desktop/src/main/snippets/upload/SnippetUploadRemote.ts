import type {
  ApiSnippet,
  CreateStoredSnippetPayload,
  PreparedStorageUpload,
} from "@plakk/shared/PlakkApi";
import type { RpcError } from "@plakk/shared/RpcError";
import { Context, type Effect } from "effect";
import type { RpcClientError } from "effect/unstable/rpc/RpcClientError";

export type SnippetUploadRemoteError = RpcError | RpcClientError;

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
>()("plakk/main/snippets/upload/SnippetUploadRemote") {}
