import type { ClientSnapshot, Snippet } from "@plakk/client-runtime";
import { deriveSnippetPresentation, type SnippetPresentation } from "@plakk/shared";
import type { SnippetRowData } from "@plakk/ui/components/SnippetRow";
import { useEffect, useMemo, useRef, useState } from "react";

import type { RunClient } from "../runtime/client.ts";
import { collectBytes } from "../runtime/client.ts";

export type SnippetReadModel = SnippetRowData & {
  readonly id: string;
  readonly presentation: SnippetPresentation;
  readonly thumbnailUrl: string | null;
};

type SnippetRowReadModel = SnippetRowData & { readonly id: string };

export const REMOTE_THUMBNAIL_MAX_BYTES = 5 * 1024 * 1024;
export const REMOTE_THUMBNAIL_MAX_COUNT = 12;
const REMOTE_THUMBNAIL_CONCURRENCY = 2;
export const REMOTE_THUMBNAIL_RETRY_DELAY_MS = 30_000;

export const selectRemoteThumbnailSnippets = (
  snippets: ReadonlyArray<Snippet>,
): ReadonlyArray<Snippet> =>
  snippets
    .filter(
      (snippet) =>
        snippet.status === "PUBLISHED" &&
        snippet.byteSize <= REMOTE_THUMBNAIL_MAX_BYTES &&
        deriveSnippetPresentation({ fileName: snippet.fileName }).type === "image",
    )
    .slice(0, REMOTE_THUMBNAIL_MAX_COUNT);

export const projectSnippetReadModels = (
  snippets: ReadonlyArray<Snippet>,
  thumbnailUrls: Readonly<Record<string, string>>,
): ReadonlyArray<SnippetReadModel> =>
  snippets.map((snippet) => {
    const presentation = deriveSnippetPresentation({
      fileName: snippet.fileName,
      ...(snippet.title === undefined ? {} : { content: snippet.title }),
    });
    const row: SnippetRowReadModel =
      snippet.status === "PUBLISHED"
        ? {
            id: snippet.id,
            fileName: snippet.fileName,
            byteSize: snippet.byteSize,
            createdAt: snippet.createdAt,
            kind: "PUBLISHED",
            localState: null,
            localContentAvailability: snippet.localContentAvailability,
          }
        : {
            id: snippet.id,
            fileName: snippet.fileName,
            byteSize: snippet.byteSize,
            createdAt: snippet.createdAt,
            kind: "LOCAL",
            localState: {
              status: snippet.status === "FAILED" ? "FAILED" : "UPLOADING",
              errorMessage: snippet.status === "FAILED" ? snippet.errorMessage : null,
            },
            localContentAvailability: snippet.localContentAvailability,
          };

    return {
      ...row,
      presentation,
      thumbnailUrl: thumbnailUrls[row.id] ?? null,
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

const useSnippetImageUrls = (snippets: ReadonlyArray<Snippet>, run: RunClient) => {
  const [thumbnailUrls, setThumbnailUrls] = useState<Record<string, string>>({});
  const [retryRevision, setRetryRevision] = useState(0);
  const registryRef = useRef<ReturnType<typeof createImageUrlRegistry> | null>(null);
  if (registryRef.current === null) registryRef.current = createImageUrlRegistry();
  const loadingIdsRef = useRef(new Set<string>());
  const failedIdsRef = useRef(new Set<string>());
  const retryTimersRef = useRef(new Map<string, number>());
  const visibleIdsRef = useRef(new Set<string>());

  useEffect(() => {
    let active = true;
    const images = selectRemoteThumbnailSnippets(snippets);
    const visibleIds = new Set(images.map((snippet) => snippet.id));
    visibleIdsRef.current = visibleIds;
    for (const id of failedIdsRef.current) {
      if (visibleIds.has(id)) continue;
      failedIdsRef.current.delete(id);
      const timer = retryTimersRef.current.get(id);
      if (timer !== undefined) window.clearTimeout(timer);
      retryTimersRef.current.delete(id);
    }

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

    const loadNext = () => {
      if (!active) return;
      while (loadingIdsRef.current.size < REMOTE_THUMBNAIL_CONCURRENCY) {
        const snippet = images.find(
          (candidate) =>
            !registry.has(candidate.id) &&
            !loadingIdsRef.current.has(candidate.id) &&
            !failedIdsRef.current.has(candidate.id),
        );
        if (snippet === undefined) return;
        loadingIdsRef.current.add(snippet.id);
        void run((client) => collectBytes(client.content.readRemote(snippet.id)))
          .then((bytes) => {
            if (!visibleIdsRef.current.has(snippet.id)) return;
            const url = registry.create(snippet.id, bytes);
            setThumbnailUrls((current) => ({ ...current, [snippet.id]: url }));
          })
          .catch(() => {
            if (!visibleIdsRef.current.has(snippet.id)) return;
            failedIdsRef.current.add(snippet.id);
            if (!retryTimersRef.current.has(snippet.id)) {
              retryTimersRef.current.set(
                snippet.id,
                window.setTimeout(() => {
                  retryTimersRef.current.delete(snippet.id);
                  failedIdsRef.current.delete(snippet.id);
                  setRetryRevision((current) => current + 1);
                }, REMOTE_THUMBNAIL_RETRY_DELAY_MS),
              );
            }
          })
          .finally(() => {
            loadingIdsRef.current.delete(snippet.id);
            loadNext();
          });
      }
    };
    loadNext();
    return () => {
      active = false;
    };
  }, [retryRevision, run, snippets]);

  useEffect(
    () => () => {
      visibleIdsRef.current.clear();
      loadingIdsRef.current.clear();
      failedIdsRef.current.clear();
      for (const timer of retryTimersRef.current.values()) window.clearTimeout(timer);
      retryTimersRef.current.clear();
      registryRef.current?.dispose();
    },
    [],
  );

  return thumbnailUrls;
};

export function useSnippets(state: {
  readonly loading: boolean;
  readonly snapshot: ClientSnapshot | null;
  readonly run: RunClient;
}) {
  const thumbnailUrls = useSnippetImageUrls(state.snapshot?.snippets ?? [], state.run);
  const items = useMemo(
    () => projectSnippetReadModels(state.snapshot?.snippets ?? [], thumbnailUrls),
    [state.snapshot, thumbnailUrls],
  );

  return {
    isLoading: state.loading || (items.length === 0 && state.snapshot?.syncStatus === "STARTING"),
    items,
  };
}
