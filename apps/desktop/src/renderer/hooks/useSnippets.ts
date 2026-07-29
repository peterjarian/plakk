import {
  deriveSnippetPresentation,
  isTextSnippetFileName,
  type LocalContentAvailability,
  type SnippetPresentation,
} from "@plakk/shared";
import { useEffect, useMemo, useRef, useState } from "react";

import type { DesktopSnippet } from "../../ipc/contracts.ts";
import { useLocalState } from "./useLocalState.tsx";

export type SnippetReadModel = {
  readonly id: string;
  readonly fileName: string;
  readonly byteSize: number;
  readonly createdAt: string;
  readonly kind: "LOCAL" | "PUBLISHED";
  readonly localState: null | {
    readonly status: "UPLOADING" | "FAILED";
    readonly errorMessage: string | null;
  };
  readonly localContentAvailability: LocalContentAvailability;
  readonly localTextPreview: string | null;
  readonly presentation: SnippetPresentation;
  readonly thumbnailUrl: string | null;
};

type SnippetRowReadModel = Omit<
  SnippetReadModel,
  "localTextPreview" | "presentation" | "thumbnailUrl"
>;

export const projectSnippetReadModels = (
  replicaItems: ReadonlyArray<DesktopSnippet>,
  thumbnailUrls: Readonly<Record<string, string>>,
): ReadonlyArray<SnippetReadModel> =>
  replicaItems.flatMap(({ snippet, localTextPreview }) => {
    if (
      isTextSnippetFileName(snippet.fileName) &&
      snippet.title === undefined &&
      localTextPreview === null &&
      (snippet.status === "PREPARING" ||
        snippet.status === "UPLOADING" ||
        (snippet.status === "PUBLISHED" &&
          (snippet.localContentAvailability.status === "NOT_AVAILABLE" ||
            snippet.localContentAvailability.status === "DOWNLOADING")))
    ) {
      return [];
    }
    const presentationContent = localTextPreview ?? snippet.title;
    const presentation = deriveSnippetPresentation({
      fileName: snippet.fileName,
      ...(presentationContent === undefined ? {} : { content: presentationContent }),
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
    return [
      {
        ...row,
        localTextPreview,
        presentation,
        thumbnailUrl: thumbnailUrls[row.id] ?? null,
      },
    ];
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

const useSnippetImageUrls = (snippets: ReadonlyArray<DesktopSnippet>) => {
  const [thumbnailUrls, setThumbnailUrls] = useState<Record<string, string>>({});
  const registryRef = useRef<ReturnType<typeof createImageUrlRegistry> | null>(null);
  if (registryRef.current === null) registryRef.current = createImageUrlRegistry();
  const loadingIdsRef = useRef(new Set<string>());
  const visibleIdsRef = useRef(new Set<string>());

  useEffect(() => {
    const images = snippets.filter(
      ({ snippet }) =>
        deriveSnippetPresentation({ fileName: snippet.fileName }).type === "image" &&
        snippet.localContentAvailability.status === "AVAILABLE",
    );
    const visibleIds = new Set(images.map(({ snippet }) => snippet.id));
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

    for (const { snippet } of images) {
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
  const state = useLocalState();
  const replicaItems = state.localState.snippets;
  const thumbnailUrls = useSnippetImageUrls(replicaItems);
  const items = useMemo(
    () => projectSnippetReadModels(replicaItems, thumbnailUrls),
    [replicaItems, thumbnailUrls],
  );

  return {
    error: state.error,
    isLoading: state.isLoading,
    items,
    reload: state.reload,
  };
}
