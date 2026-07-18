import type {
  ApiSnippet,
  CreateStoredSnippetPayload,
  PreparedStorageUpload,
} from "@plakk/shared/PlakkApi";
import type { RpcError } from "@plakk/shared/RpcError";
import { Context, type Effect } from "effect";

export type PrepareSnippetUploadInput = {
  readonly id: string;
  readonly mediaType: string | null;
};

export type CompleteSnippetUploadInput = {
  readonly id: string;
  readonly storageObjectId: string;
};

export class SnippetUploads extends Context.Service<
  SnippetUploads,
  {
    readonly create: (
      ownerWorkosUserId: string,
      input: CreateStoredSnippetPayload,
    ) => Effect.Effect<ApiSnippet, RpcError>;
    readonly prepare: (
      ownerWorkosUserId: string,
      input: PrepareSnippetUploadInput,
    ) => Effect.Effect<PreparedStorageUpload, RpcError>;
    readonly heartbeat: (
      ownerWorkosUserId: string,
      id: string,
    ) => Effect.Effect<{ readonly expiresAt: string }, RpcError>;
    readonly fail: (ownerWorkosUserId: string, id: string) => Effect.Effect<ApiSnippet, RpcError>;
    readonly retry: (ownerWorkosUserId: string, id: string) => Effect.Effect<ApiSnippet, RpcError>;
    readonly complete: (
      ownerWorkosUserId: string,
      input: CompleteSnippetUploadInput,
    ) => Effect.Effect<ApiSnippet, RpcError>;
    readonly expire: Effect.Effect<number>;
  }
>()("@plakk/backend/api/snippets/SnippetUploads") {}
