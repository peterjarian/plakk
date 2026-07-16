import { useEffect, useRef, useState } from "react";
import { deriveSnippetPresentation } from "@plakk/shared";

import type { DesktopSnippet } from "../../ipc/contracts.ts";

export function useSnippetThumbnails(snippets: ReadonlyArray<DesktopSnippet>) {
  const [thumbnailUrls, setThumbnailUrls] = useState<Record<string, string>>({});
  const objectUrlsRef = useRef(new Map<string, string>());
  const loadingIdsRef = useRef(new Set<string>());
  const visibleIdsRef = useRef(new Set<string>());

  useEffect(() => {
    const images = snippets.filter(
      (snippet) =>
        deriveSnippetPresentation({ fileName: snippet.fileName }).type === "image" &&
        (snippet.contentAvailable || snippet.uploadStatus === "UPLOADED"),
    );
    const visibleIds = new Set(images.map((snippet) => snippet.id));
    visibleIdsRef.current = visibleIds;

    for (const [id, url] of objectUrlsRef.current) {
      if (visibleIds.has(id)) continue;
      URL.revokeObjectURL(url);
      objectUrlsRef.current.delete(id);
      setThumbnailUrls((current) => {
        const { [id]: _removed, ...remaining } = current;
        return remaining;
      });
    }

    for (const snippet of images) {
      if (objectUrlsRef.current.has(snippet.id) || loadingIdsRef.current.has(snippet.id)) continue;
      loadingIdsRef.current.add(snippet.id);
      void window.ipc.snippets
        .read(snippet.id)
        .then((bytes) => {
          if (!visibleIdsRef.current.has(snippet.id)) return;
          const url = URL.createObjectURL(
            new Blob([Uint8Array.from(bytes)], { type: "application/octet-stream" }),
          );
          objectUrlsRef.current.set(snippet.id, url);
          setThumbnailUrls((current) => ({ ...current, [snippet.id]: url }));
        })
        .catch(() => {
          // The image icon remains visible when preview loading fails.
        })
        .finally(() => loadingIdsRef.current.delete(snippet.id));
    }
  }, [snippets]);

  useEffect(
    () => () => {
      visibleIdsRef.current.clear();
      for (const url of objectUrlsRef.current.values()) URL.revokeObjectURL(url);
      objectUrlsRef.current.clear();
    },
    [],
  );

  return thumbnailUrls;
}
