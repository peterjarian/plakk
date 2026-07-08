import { useAtomRefresh, useAtomSet, useAtomValue } from "@effect/atom-react";
import type { ApiSnippet } from "@plakk/shared/PlakkApi";
import { AsyncResult } from "effect/unstable/reactivity";
import { useMemo } from "react";

import {
  apiSnippetToSnippet,
  createSnippetPayload,
  createTextSnippetAtom,
  deleteSnippetAtom,
  deleteSnippetPayload,
  emptySnippetsAtom,
  snippetMutationInput,
  snippetsQueryAtom,
} from "../atoms/snippets.ts";

export function useSnippets(accessToken: string | null) {
  const atom = useMemo(
    () => (accessToken === null ? emptySnippetsAtom : snippetsQueryAtom(accessToken)),
    [accessToken],
  );
  const result = useAtomValue(atom);
  const refresh = useAtomRefresh(atom);
  const response = AsyncResult.getOrElse(result, () => ({
    items: [] as ReadonlyArray<ApiSnippet>,
  }));

  return {
    error: AsyncResult.isFailure(result) ? "Could not sync snippets." : null,
    isLoading: result.waiting || AsyncResult.isInitial(result),
    refresh,
    snippets: response.items.map(apiSnippetToSnippet),
  };
}

export function useSnippetActions(accessToken: string | null) {
  const createText = useAtomSet(createTextSnippetAtom, { mode: "promise" });
  const deleteSnippet = useAtomSet(deleteSnippetAtom, { mode: "promise" });

  return useMemo(
    () => ({
      createText(text: string) {
        if (accessToken === null) return Promise.resolve(null);
        return createText(snippetMutationInput(accessToken, createSnippetPayload(text)));
      },
      delete(id: string) {
        if (accessToken === null) return Promise.resolve(null);
        return deleteSnippet(snippetMutationInput(accessToken, deleteSnippetPayload(id)));
      },
    }),
    [accessToken, createText, deleteSnippet],
  );
}
