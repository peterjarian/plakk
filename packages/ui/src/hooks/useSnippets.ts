import { RegistryContext, useAtomSet, useAtomValue } from "@effect/atom-react";
import type { Snippet } from "@plakk/shared";
import { useContext, useMemo } from "react";
import {
  removeSnippet,
  snippetsAtom,
  upsertSnippet,
  visibleSnippetsAtom,
} from "../atoms/snippets.ts";

export function useVisibleSnippets() {
  return useAtomValue(visibleSnippetsAtom);
}

export function useSnippetActions() {
  const registry = useContext(RegistryContext);
  const setSnippets = useAtomSet(snippetsAtom);

  return useMemo(
    () => ({
      setAll(snippets: ReadonlyArray<Snippet>) {
        setSnippets(snippets.slice(0, 20));
      },
      upsert(snippet: Snippet) {
        setSnippets((snippets) => upsertSnippet(snippets, snippet));
      },
      remove(id: string) {
        setSnippets((snippets) => removeSnippet(snippets, id));
      },
      snapshot() {
        return registry.get(snippetsAtom);
      },
    }),
    [registry, setSnippets],
  );
}
