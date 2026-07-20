import type {
  ApiSnippet,
  PreparedStorageUpload,
  PrepareSnippetUploadPayload,
  PublishSnippetPayload,
} from "@plakk/shared/PlakkApi";
import type { RpcError } from "@plakk/shared/RpcError";
import { Context, type Effect } from "effect";
import type { RpcClientError } from "effect/unstable/rpc/RpcClientError";

export type SnippetUploadRemoteError = RpcError | RpcClientError;

export class SnippetUploadRemote extends Context.Service<
  SnippetUploadRemote,
  {
    prepare(
      accessToken: string,
      input: PrepareSnippetUploadPayload,
    ): Effect.Effect<PreparedStorageUpload, SnippetUploadRemoteError>;
    publish(
      accessToken: string,
      input: PublishSnippetPayload,
    ): Effect.Effect<ApiSnippet, SnippetUploadRemoteError>;
    delete(accessToken: string, id: string): Effect.Effect<void, SnippetUploadRemoteError>;
  }
>()("plakk/main/snippets/upload/SnippetUploadRemote") {}
