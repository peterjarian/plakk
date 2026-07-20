import type {
  ApiSnippet,
  PreparedStorageUpload,
  PrepareSnippetUploadPayload,
  PublishSnippetPayload,
} from "@plakk/shared/PlakkApi";
import type { RpcError } from "@plakk/shared/RpcError";
import { Context, type Effect } from "effect";

export class SnippetUploads extends Context.Service<
  SnippetUploads,
  {
    readonly prepare: (
      ownerWorkosUserId: string,
      input: PrepareSnippetUploadPayload,
    ) => Effect.Effect<PreparedStorageUpload, RpcError>;
    readonly publish: (
      ownerWorkosUserId: string,
      input: PublishSnippetPayload,
    ) => Effect.Effect<ApiSnippet, RpcError>;
  }
>()("@plakk/backend/api/snippets/SnippetUploads") {}
