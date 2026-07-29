import type { StorageProvider } from "@plakk/shared";

import { encodeTextSnippet } from "./textSnippetContent.ts";

type IngestibleFile = Pick<File, "name" | "size" | "type">;

export function ingestTextSnippet(
  storageProvider: StorageProvider,
  text: string,
): Promise<void> | null {
  const bytes = encodeTextSnippet(text);
  if (bytes.byteLength === 0) return null;

  const id = crypto.randomUUID();
  return window.ipc.snippets.ingest({
    id,
    fileName: `${id}.txt`,
    byteSize: bytes.byteLength,
    mediaType: "text/plain; charset=utf-8",
    storageProvider,
    bytes,
  });
}

export function ingestFileSnippet(
  storageProvider: StorageProvider,
  file: IngestibleFile,
  sourceId?: string,
): Promise<void> {
  return window.ipc.snippets.ingest({
    id: crypto.randomUUID(),
    fileName: file.name,
    byteSize: file.size,
    mediaType: file.type || null,
    storageProvider,
    ...(sourceId === undefined ? { file: file as File } : { sourceId }),
  });
}
