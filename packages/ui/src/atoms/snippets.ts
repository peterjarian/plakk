import type { ApiSnippet } from "@plakk/shared/PlakkApi";
import { AsyncResult, Atom } from "effect/unstable/reactivity";

import { createPlakkRpc } from "./rpc.ts";

export type SnippetRequestHeaders = {
  readonly authorization: string;
};

export const snippetReactivityKeys = ["plakk:snippets"] as const;

export const listSnippetsQueryOptions = (headers: SnippetRequestHeaders) => ({
  payload: { limit: 20 },
  headers,
  reactivityKeys: snippetReactivityKeys,
  serializationKey: "latest",
});

export const emptySnippetsAtom = Atom.make(
  AsyncResult.success<{ readonly items: ReadonlyArray<ApiSnippet> }, never>({ items: [] }),
).pipe(Atom.withLabel("plakk:empty-snippets"));

export const createTextSnippetAtom = (rpc: ReturnType<typeof createPlakkRpc>) =>
  rpc.mutation("CreateTextSnippet").pipe(Atom.withLabel("plakk:create-text-snippet"));

export const deleteSnippetAtom = (rpc: ReturnType<typeof createPlakkRpc>) =>
  rpc.mutation("DeleteSnippet").pipe(Atom.withLabel("plakk:delete-snippet"));

export const createTextSnippetOptions = (headers: SnippetRequestHeaders, text: string) => ({
  headers,
  payload: { id: crypto.randomUUID(), text },
  reactivityKeys: snippetReactivityKeys,
});

export const deleteSnippetOptions = (headers: SnippetRequestHeaders, id: string) => ({
  headers,
  payload: { id },
  reactivityKeys: snippetReactivityKeys,
});
