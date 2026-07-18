import type { ApiSnippet } from "@plakk/shared/PlakkApi";
import type { RpcError } from "@plakk/shared/RpcError";
import { Context, type Effect, Schema, type Stream } from "effect";
import type { RpcClientError } from "effect/unstable/rpc/RpcClientError";

import type { DesktopSnippet, ResolvedSnippetIngestPayload } from "../../../ipc/contracts.ts";
import type { ManagedSnippetContentError } from "../content/ManagedSnippetContent.ts";
import type { SnippetReplicaError } from "../replica/SnippetReplica.ts";
import type { SnippetUploadOutboxError } from "./SnippetUploadOutbox.ts";
import type { StorageUploadError } from "./StorageUpload.ts";

export type UploadAccount = { readonly id: string; readonly accessToken: string };
export type UploadOwner = { readonly id: string; readonly accessToken: string | null };

export type UploadProjectedSnippet = Omit<
  DesktopSnippet,
  "localTextPreview" | "localContentAvailability"
> & {
  readonly storageObjectId?: string | null;
  readonly importingContent?: Pick<DesktopSnippet, "localTextPreview" | "localContentAvailability">;
};

export class SnippetUploadEngineError extends Schema.TaggedErrorClass<SnippetUploadEngineError>()(
  "SnippetUploadEngineError",
  {
    cause: Schema.Defect(),
    reason: Schema.String,
    canRetry: Schema.Boolean,
  },
) {}

export type SnippetUploadEngineFailure =
  | SnippetUploadEngineError
  | ManagedSnippetContentError
  | SnippetReplicaError
  | SnippetUploadOutboxError
  | StorageUploadError
  | RpcError
  | RpcClientError;

export class SnippetUploadEngine extends Context.Service<
  SnippetUploadEngine,
  {
    readonly changes: Stream.Stream<string>;
    ingest(
      accountId: string,
      input: ResolvedSnippetIngestPayload,
    ): Effect.Effect<void, SnippetUploadEngineFailure>;
    resume(account: UploadAccount): Effect.Effect<void, SnippetUploadEngineFailure>;
    pause: Effect.Effect<void>;
    purge(accountId: string): Effect.Effect<void, SnippetUploadEngineFailure>;
    project(
      accountId: string,
      replicaItems: ReadonlyArray<ApiSnippet>,
    ): Effect.Effect<ReadonlyArray<UploadProjectedSnippet>, SnippetUploadEngineFailure>;
    cancel(
      account: UploadOwner,
      snippetId: string,
    ): Effect.Effect<void, SnippetUploadEngineFailure>;
    retry(account: UploadOwner, snippetId: string): Effect.Effect<void, SnippetUploadEngineFailure>;
    discard(accountId: string, snippetId: string): Effect.Effect<void, SnippetUploadEngineFailure>;
    delete(
      account: UploadOwner,
      snippetId: string,
    ): Effect.Effect<void, SnippetUploadEngineFailure>;
    removeTombstones(
      accountId: string,
      snippetIds: ReadonlyArray<string>,
    ): Effect.Effect<void, SnippetUploadOutboxError>;
    reconcile(
      accountId: string,
      replicaItems: ReadonlyArray<ApiSnippet>,
    ): Effect.Effect<void, SnippetUploadEngineFailure>;
  }
>()("plakk/main/snippets/upload/SnippetUploadEngine") {}
