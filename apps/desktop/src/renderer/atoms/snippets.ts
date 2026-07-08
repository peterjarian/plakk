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

const rpcUrl = import.meta.env.VITE_PLAKK_RPC_URL ?? "https://app.plakk.io/api/rpc";
export const snippetReactivityKeys = ["plakk:snippets"] as const;

export class PlakkRpc extends AtomRpc.Service<PlakkRpc>()("plakk/desktop/renderer/atoms/PlakkRpc", {
  group: PlakkApi,
  protocol: RpcClient.layerProtocolHttp({ url: rpcUrl }).pipe(
    Layer.provideMerge(FetchHttpClient.layer),
    Layer.provideMerge(RpcSerialization.layerNdjson),
  ),
}) {}

const authHeaders = (accessToken: string) => ({ authorization: `Bearer ${accessToken}` });

export const snippetsQueryAtom = (accessToken: string) =>
  PlakkRpc.query(
    "ListSnippets",
    { limit: 20 },
    {
      headers: authHeaders(accessToken),
      reactivityKeys: snippetReactivityKeys,
      serializationKey: "latest",
    },
  );

export const emptySnippetsAtom = Atom.make(
  AsyncResult.success<{ readonly items: ReadonlyArray<ApiSnippet> }, never>({ items: [] }),
).pipe(Atom.withLabel("plakk:empty-snippets"));

export const createTextSnippetAtom = PlakkRpc.mutation("CreateTextSnippet").pipe(
  Atom.withLabel("plakk:create-text-snippet"),
);

export const deleteSnippetAtom = PlakkRpc.mutation("DeleteSnippet").pipe(
  Atom.withLabel("plakk:delete-snippet"),
);

export const createSnippetPayload = (text: string) => ({
  id: crypto.randomUUID(),
  text,
});

export const deleteSnippetPayload = (id: string) => ({ id });

export const snippetMutationInput = <Payload>(accessToken: string, payload: Payload) => ({
  headers: authHeaders(accessToken),
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
