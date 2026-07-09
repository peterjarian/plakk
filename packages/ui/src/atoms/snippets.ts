import {
  formatFileSize,
  type Snippet,
  type SnippetKind,
  type StorageProvider,
} from "@plakk/shared";
import { PlakkApi, type ApiSnippet } from "@plakk/shared/PlakkApi";
import * as Layer from "effect/Layer";
import { FetchHttpClient } from "effect/unstable/http";
import { RpcClient, RpcSerialization } from "effect/unstable/rpc";
import { AsyncResult, Atom, AtomRpc } from "effect/unstable/reactivity";

export type SnippetRequestHeaders = {
  readonly authorization: string;
};

export const snippetReactivityKeys = ["plakk:snippets"] as const;

export const createSnippetAtoms = (rpcUrl: string) => {
  class PlakkRpc extends AtomRpc.Service<PlakkRpc>()("plakk/ui/atoms/PlakkRpc", {
    group: PlakkApi,
    protocol: RpcClient.layerProtocolHttp({ url: rpcUrl }).pipe(
      Layer.provideMerge(FetchHttpClient.layer),
      Layer.provideMerge(RpcSerialization.layerNdjson),
    ),
  }) {}

  return {
    snippetsQueryAtom: (headers: SnippetRequestHeaders) =>
      PlakkRpc.query("ListSnippets", listSnippetsPayload, listSnippetsQueryOptions(headers)),
    createTextSnippetAtom: PlakkRpc.mutation("CreateTextSnippet").pipe(
      Atom.withLabel("plakk:create-text-snippet"),
    ),
    deleteSnippetAtom: PlakkRpc.mutation("DeleteSnippet").pipe(
      Atom.withLabel("plakk:delete-snippet"),
    ),
  };
};

export const listSnippetsPayload = { limit: 20 } as const;

export const listSnippetsQueryOptions = (headers: SnippetRequestHeaders) => ({
  headers,
  reactivityKeys: snippetReactivityKeys,
  serializationKey: "latest",
});

export const emptySnippetsAtom = Atom.make(
  AsyncResult.success<{ readonly items: ReadonlyArray<ApiSnippet> }, never>({ items: [] }),
).pipe(Atom.withLabel("plakk:empty-snippets"));

export const createSnippetPayload = (text: string) => ({
  id: crypto.randomUUID(),
  text,
});

export const deleteSnippetPayload = (id: string) => ({ id });

export const snippetMutationOptions = <Payload>(
  headers: SnippetRequestHeaders,
  payload: Payload,
) => ({
  headers,
  payload,
  reactivityKeys: snippetReactivityKeys,
});

export const apiSnippetToSnippet = (snippet: ApiSnippet): Snippet => {
  const isStored = snippet.kind === "FILE" || snippet.kind === "IMAGE";
  return {
    id: snippet.id,
    title: snippet.title,
    subtitle: isStored
      ? `${snippet.fileName.split(".").pop()?.toUpperCase() ?? snippet.kind} · ${formatFileSize(snippet.byteSize)}`
      : formatFileSize(snippet.byteSize),
    kind: snippet.kind,
    time: snippet.createdAt.slice(0, 10),
    synced: snippet.uploadStatus === "READY",
    ...(snippet.uploadStatus === "UPLOADING" ? { uploadProgress: 0 } : {}),
  };
};

export const uploadTaskToSnippet = (task: {
  readonly id: string;
  readonly fileName: string;
  readonly byteSize: number;
  readonly kind: Extract<SnippetKind, "FILE" | "IMAGE">;
  readonly progress: number;
  readonly storageProvider: StorageProvider;
}): Snippet => ({
  id: task.id,
  title: task.fileName,
  subtitle: `${task.fileName.split(".").pop()?.toUpperCase() ?? task.kind} · ${formatFileSize(task.byteSize)}`,
  kind: task.kind,
  time: "",
  synced: false,
  uploadProgress: task.progress,
});
