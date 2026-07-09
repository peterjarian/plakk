import type { ApiSnippet } from "@plakk/shared/PlakkApi";
import { AsyncResult, Atom } from "effect/unstable/reactivity";

export type SnippetRequestHeaders = {
  readonly authorization: string;
};

export const snippetReactivityKeys = ["plakk:snippets"] as const;

export const emptySnippetsAtom = Atom.make(
  AsyncResult.success<{ readonly items: ReadonlyArray<ApiSnippet> }, never>({ items: [] }),
).pipe(Atom.withLabel("plakk:empty-snippets"));

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
