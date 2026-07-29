import type { ClientSnapshot } from "@plakk/client-runtime";
import {
  decodeSnippetTextPreview,
  isTextSnippetFileName,
  SNIPPET_TEXT_PREVIEW_MAX_BYTES,
} from "@plakk/shared";
import { Effect } from "effect";
import { useEffect, useRef, useState } from "react";

import { collectBytes, type RunClient } from "../runtime/client.ts";

const TEXT_PREVIEW_LIMIT = 50;

export function useSnippetPreviews(snapshot: ClientSnapshot | null, run: RunClient) {
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
}
