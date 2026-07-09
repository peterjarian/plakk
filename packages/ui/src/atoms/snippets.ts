import type { Snippet } from "@plakk/shared";
import { Atom } from "effect/unstable/reactivity";
import { uploadSnippetsAtom } from "./upload.ts";

export const snippetsAtom = Atom.make<ReadonlyArray<Snippet>>([]).pipe(
  Atom.keepAlive,
  Atom.withLabel("plakk:snippets"),
);

export const visibleSnippetsAtom = Atom.make((get) => {
  const uploads = get(uploadSnippetsAtom);
  const uploadIds = new Set(uploads.map((snippet) => snippet.id));

  return [...uploads, ...get(snippetsAtom).filter((snippet) => !uploadIds.has(snippet.id))].slice(
    0,
    20,
  );
}).pipe(Atom.withLabel("plakk:visible-snippets"));

export const upsertSnippet = (
  snippets: ReadonlyArray<Snippet>,
  snippet: Snippet,
): ReadonlyArray<Snippet> =>
  [snippet, ...snippets.filter((current) => current.id !== snippet.id)].slice(0, 20);

export const removeSnippet = (
  snippets: ReadonlyArray<Snippet>,
  id: string,
): ReadonlyArray<Snippet> => snippets.filter((snippet) => snippet.id !== id);
