import type { RpcError } from "@plakk/shared/RpcError";
import { Context, type Effect, Schema } from "effect";
import type { RpcClientError } from "effect/unstable/rpc/RpcClientError";

import type { ResolvedSnippetIngestPayload } from "../../../ipc/contracts.ts";
import type { ManagedSnippetContentError } from "../content/ManagedSnippetContent.ts";
import type { SnippetReplicaError } from "../replica/SnippetReplica.ts";
import type { StorageUploadError } from "./StorageUpload.ts";

export type UploadAccount = { readonly id: string; readonly accessToken: string };
export type UploadOwner = { readonly id: string; readonly accessToken: string | null };

export class SnippetUploadEngineError extends Schema.TaggedErrorClass<SnippetUploadEngineError>()(
  "SnippetUploadEngineError",
  {
    cause: Schema.Defect(),
    reason: Schema.String,
  },
) {}

export type SnippetUploadEngineFailure =
  | SnippetUploadEngineError
  | ManagedSnippetContentError
  | SnippetReplicaError
  | StorageUploadError
  | RpcError
  | RpcClientError;

export class SnippetUploadEngine extends Context.Service<
  SnippetUploadEngine,
  {
    ingest(
      account: UploadAccount,
      input: ResolvedSnippetIngestPayload,
    ): Effect.Effect<void, SnippetUploadEngineFailure>;
    normalize(accountId: string): Effect.Effect<void, SnippetUploadEngineFailure>;
    pause: Effect.Effect<void>;
    purge(accountId: string): Effect.Effect<void, SnippetUploadEngineFailure>;
    discard(accountId: string, snippetId: string): Effect.Effect<void, SnippetUploadEngineFailure>;
    delete(
      account: UploadOwner,
      snippetId: string,
    ): Effect.Effect<void, SnippetUploadEngineFailure>;
  }
>()("plakk/main/snippets/upload/SnippetUploadEngine") {}
