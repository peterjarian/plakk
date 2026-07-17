import { deriveSnippetPresentation, type SnippetPresentation } from "@plakk/shared";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import type { DesktopSnippet } from "../../ipc/contracts.ts";

const snippetListErrorMessage = "Couldn’t load snippets. Try again.";

type SnippetSubscriptionState = {
  readonly items: ReadonlyArray<DesktopSnippet>;
  readonly isLoading: boolean;
  readonly error: string | null;
  readonly changeRevision: number;
};

type SnippetSubscriptionAction =
  | { readonly type: "load-started" }
  | {
      readonly type: "load-succeeded";
      readonly items: ReadonlyArray<DesktopSnippet>;
      readonly requestRevision: number;
    }
  | { readonly type: "load-failed"; readonly requestRevision: number }
  | { readonly type: "changed"; readonly items: ReadonlyArray<DesktopSnippet> };

export type SnippetReadModel = DesktopSnippet & {
  readonly presentation: SnippetPresentation;
  readonly thumbnailUrl: string | null;
};

export const initialSnippetSubscriptionState: SnippetSubscriptionState = {
  items: [],
  isLoading: true,
  error: null,
  changeRevision: 0,
};

export const updateSnippetSubscription = (
  state: SnippetSubscriptionState,
  action: SnippetSubscriptionAction,
): SnippetSubscriptionState => {
  switch (action.type) {
    case "load-started":
      return { ...state, isLoading: true, error: null };
    case "load-succeeded":
      return {
        ...state,
        items: action.requestRevision === state.changeRevision ? action.items : state.items,
        isLoading: false,
        error: null,
      };
    case "load-failed":
      return {
        ...state,
        isLoading: false,
        error:
          action.requestRevision === state.changeRevision ? snippetListErrorMessage : state.error,
      };
    case "changed":
      return {
        items: action.items,
        isLoading: false,
        error: null,
        changeRevision: state.changeRevision + 1,
      };
  }
};

export const projectSnippetReadModels = (
  replicaItems: ReadonlyArray<DesktopSnippet>,
  thumbnailUrls: Readonly<Record<string, string>>,
): ReadonlyArray<SnippetReadModel> =>
  replicaItems.map((snippet) => {
    const presentation = deriveSnippetPresentation({
      fileName: snippet.fileName,
      ...(snippet.localTextPreview === null ? {} : { content: snippet.localTextPreview }),
    });
    return {
      ...snippet,
      presentation,
      thumbnailUrl: thumbnailUrls[snippet.id] ?? null,
    };
  });

export const createImageUrlRegistry = () => {
  const urls = new Map<string, string>();

  return {
    create(id: string, bytes: Uint8Array): string {
      const existing = urls.get(id);
      if (existing !== undefined) return existing;
      const url = URL.createObjectURL(
        new Blob([Uint8Array.from(bytes)], { type: "application/octet-stream" }),
      );
      urls.set(id, url);
      return url;
    },
    has(id: string): boolean {
      return urls.has(id);
    },
    retain(ids: ReadonlySet<string>): ReadonlyArray<string> {
      const removed: Array<string> = [];
      for (const [id, url] of urls) {
        if (ids.has(id)) continue;
        URL.revokeObjectURL(url);
        urls.delete(id);
        removed.push(id);
      }
      return removed;
    },
    dispose(): void {
      for (const url of urls.values()) URL.revokeObjectURL(url);
      urls.clear();
    },
  };
};

const useSnippetSubscription = () => {
  const [state, setState] = useState<SnippetSubscriptionState>(initialSnippetSubscriptionState);
  const mountedRef = useRef(false);
  const changeRevisionRef = useRef(0);

  const reload = useCallback(() => {
    const requestRevision = changeRevisionRef.current;
    setState((current) => updateSnippetSubscription(current, { type: "load-started" }));
    void window.ipc.snippets.list().then(
      (items) => {
        if (!mountedRef.current) return;
        setState((current) =>
          updateSnippetSubscription(current, {
            type: "load-succeeded",
            items,
            requestRevision,
          }),
        );
      },
      () => {
        if (!mountedRef.current) return;
        setState((current) =>
          updateSnippetSubscription(current, { type: "load-failed", requestRevision }),
        );
      },
    );
  }, []);

  useEffect(() => {
    mountedRef.current = true;
    const unsubscribe = window.ipc.snippets.onChanged((items) => {
      changeRevisionRef.current += 1;
      setState((current) => updateSnippetSubscription(current, { type: "changed", items }));
    });
    reload();
    return () => {
      mountedRef.current = false;
      unsubscribe();
    };
  }, [reload]);

  return { ...state, reload };
};

const useSnippetImageUrls = (snippets: ReadonlyArray<DesktopSnippet>) => {
  const [thumbnailUrls, setThumbnailUrls] = useState<Record<string, string>>({});
  const registryRef = useRef<ReturnType<typeof createImageUrlRegistry> | null>(null);
  if (registryRef.current === null) registryRef.current = createImageUrlRegistry();
  const loadingIdsRef = useRef(new Set<string>());
  const visibleIdsRef = useRef(new Set<string>());

  useEffect(() => {
    const images = snippets.filter(
      (snippet) =>
        deriveSnippetPresentation({ fileName: snippet.fileName }).type === "image" &&
        snippet.localContentAvailability.status === "AVAILABLE",
    );
    const visibleIds = new Set(images.map(({ id }) => id));
    visibleIdsRef.current = visibleIds;

    const registry = registryRef.current;
    if (registry === null) return;
    const removedIds = registry.retain(visibleIds);
    if (removedIds.length > 0) {
      setThumbnailUrls((current) => {
        const next = { ...current };
        for (const id of removedIds) delete next[id];
        return next;
      });
    }

    for (const snippet of images) {
      if (registry.has(snippet.id) || loadingIdsRef.current.has(snippet.id)) continue;
      loadingIdsRef.current.add(snippet.id);
      void window.ipc.snippets
        .read(snippet.id)
        .then((bytes) => {
          if (!visibleIdsRef.current.has(snippet.id)) return;
          const url = registry.create(snippet.id, bytes);
          setThumbnailUrls((current) => ({ ...current, [snippet.id]: url }));
        })
        .catch(() => {
          // The file icon remains visible if a preview cannot be read.
        })
        .finally(() => loadingIdsRef.current.delete(snippet.id));
    }
  }, [snippets]);

  useEffect(
    () => () => {
      visibleIdsRef.current.clear();
      loadingIdsRef.current.clear();
      registryRef.current?.dispose();
    },
    [],
  );

  return thumbnailUrls;
};

export function useSnippets() {
  const { items: replicaItems, isLoading, error, reload } = useSnippetSubscription();
  const thumbnailUrls = useSnippetImageUrls(replicaItems);
  const items = useMemo(
    () => projectSnippetReadModels(replicaItems, thumbnailUrls),
    [replicaItems, thumbnailUrls],
  );

  return { error, isLoading, items, reload };
}
