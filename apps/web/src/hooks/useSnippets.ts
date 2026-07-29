import type { ClientSnapshot, Snippet } from "@plakk/client-runtime";
import {
  decodeSnippetTextPreview,
  deriveSnippetPresentation,
  isTextSnippetFileName,
  SNIPPET_TEXT_PREVIEW_MAX_BYTES,
  type LocalContentAvailability,
  type SnippetPresentation,
} from "@plakk/shared";
import { Effect } from "effect";
import { useEffect, useMemo, useRef, useState } from "react";

import type { RunClient } from "../runtime/client.ts";
import { collectBytes } from "../runtime/client.ts";

const TEXT_PREVIEW_LIMIT = 50;

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
  snippets: ReadonlyArray<Snippet>,
  textPreviews: Readonly<Record<string, string>>,
  thumbnailUrls: Readonly<Record<string, string>>,
): ReadonlyArray<SnippetReadModel> =>
  snippets.flatMap((snippet) => {
    const localTextPreview = textPreviews[snippet.id] ?? null;
    if (
      snippet.status === "PUBLISHED" &&
      isTextSnippetFileName(snippet.fileName) &&
      localTextPreview === null &&
      snippet.localContentAvailability.status === "DOWNLOADING"
    ) {
      return [];
    }
    const presentation = deriveSnippetPresentation({
      fileName: snippet.fileName,
      ...(localTextPreview === null ? {} : { content: localTextPreview }),
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

const useSnippetTextPreviews = (snapshot: ClientSnapshot | null, run: RunClient) => {
  const previewingRef = useRef(new Set<string>());
  const transientFailuresRef = useRef(new Map<string, number>());
  const terminalFailuresRef = useRef(new Map<string, string>());
  const retryTimersRef = useRef(new Map<string, number>());
  const [previews, setPreviews] = useState<Record<string, string>>({});
  const [retryTick, setRetryTick] = useState(0);

  useEffect(() => {
    setPreviews({});
    previewingRef.current.clear();
    transientFailuresRef.current.clear();
    terminalFailuresRef.current.clear();
    for (const timer of retryTimersRef.current.values()) window.clearTimeout(timer);
    retryTimersRef.current.clear();
  }, [snapshot?.user.id]);

  useEffect(() => {
    if (snapshot === null) return;
    const candidates = snapshot.snippets
      .slice(0, TEXT_PREVIEW_LIMIT)
      .filter(
        (snippet) =>
          snippet.status === "PUBLISHED" &&
          isTextSnippetFileName(snippet.fileName) &&
          snippet.byteSize <= SNIPPET_TEXT_PREVIEW_MAX_BYTES &&
          previews[snippet.id] === undefined &&
          terminalFailuresRef.current.get(snippet.id) !== snippet.updatedAt &&
          !previewingRef.current.has(snippet.id),
      );
    for (const snippet of candidates) previewingRef.current.add(snippet.id);

    void run((client) =>
      Effect.forEach(
        candidates,
        (snippet) =>
          collectBytes(client.content.readRemote(snippet.id)).pipe(
            Effect.tap((bytes) =>
              Effect.sync(() => {
                transientFailuresRef.current.delete(snippet.id);
                const retryTimer = retryTimersRef.current.get(snippet.id);
                if (retryTimer !== undefined) window.clearTimeout(retryTimer);
                retryTimersRef.current.delete(snippet.id);
                const preview = decodeSnippetTextPreview(bytes);
                if (preview === null) {
                  terminalFailuresRef.current.set(snippet.id, snippet.updatedAt);
                  return;
                }
                terminalFailuresRef.current.delete(snippet.id);
                setPreviews((current) => ({ ...current, [snippet.id]: preview }));
              }),
            ),
            Effect.catch((error) =>
              error._tag === "OfflineError" || error._tag === "ServerUnavailableError"
                ? Effect.sync(() => {
                    if (retryTimersRef.current.has(snippet.id)) return;
                    const failures = (transientFailuresRef.current.get(snippet.id) ?? 0) + 1;
                    transientFailuresRef.current.set(snippet.id, failures);
                    const timer = window.setTimeout(
                      () => {
                        retryTimersRef.current.delete(snippet.id);
                        setRetryTick((tick) => tick + 1);
                      },
                      Math.min(30_000, 1_000 * 2 ** Math.min(failures - 1, 5)),
                    );
                    retryTimersRef.current.set(snippet.id, timer);
                  })
                : Effect.sync(() => {
                    terminalFailuresRef.current.set(snippet.id, snippet.updatedAt);
                  }),
            ),
            Effect.ensuring(
              Effect.sync(() => {
                previewingRef.current.delete(snippet.id);
              }),
            ),
          ),
        { concurrency: 4, discard: true },
      ),
    ).catch(() => {
      // Runtime disposal can interrupt an in-flight preview batch.
    });
  }, [previews, retryTick, run, snapshot]);

  useEffect(
    () => () => {
      for (const timer of retryTimersRef.current.values()) window.clearTimeout(timer);
      retryTimersRef.current.clear();
    },
    [],
  );

  return previews;
};

const useSnippetImageUrls = (snippets: ReadonlyArray<Snippet>, run: RunClient) => {
  const [thumbnailUrls, setThumbnailUrls] = useState<Record<string, string>>({});
  const registryRef = useRef<ReturnType<typeof createImageUrlRegistry> | null>(null);
  if (registryRef.current === null) registryRef.current = createImageUrlRegistry();
  const loadingIdsRef = useRef(new Set<string>());
  const visibleIdsRef = useRef(new Set<string>());

  useEffect(() => {
    const images = snippets.filter(
      (snippet) =>
        snippet.status === "PUBLISHED" &&
        deriveSnippetPresentation({ fileName: snippet.fileName }).type === "image",
    );
    const visibleIds = new Set(images.map((snippet) => snippet.id));
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
      void run((client) => collectBytes(client.content.readRemote(snippet.id)))
        .then((bytes) => {
          if (!visibleIdsRef.current.has(snippet.id)) return;
          const url = registry.create(snippet.id, bytes);
          setThumbnailUrls((current) => ({ ...current, [snippet.id]: url }));
        })
        .catch(() => {
          // The file icon remains visible if a thumbnail cannot be read.
        })
        .finally(() => loadingIdsRef.current.delete(snippet.id));
    }
  }, [run, snippets]);

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

export function useSnippets(state: {
  readonly error: string | null;
  readonly loading: boolean;
  readonly snapshot: ClientSnapshot | null;
  readonly run: RunClient;
  readonly refresh: () => Promise<void>;
}) {
  const textPreviews = useSnippetTextPreviews(state.snapshot, state.run);
  const thumbnailUrls = useSnippetImageUrls(state.snapshot?.snippets ?? [], state.run);
  const items = useMemo(
    () => projectSnippetReadModels(state.snapshot?.snippets ?? [], textPreviews, thumbnailUrls),
    [state.snapshot, textPreviews, thumbnailUrls],
  );

  return {
    error: state.error,
    isLoading: state.loading,
    items,
    reload: state.refresh,
  };
}
