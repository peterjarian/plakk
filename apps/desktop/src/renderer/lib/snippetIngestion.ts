import type { StorageProvider } from "@plakk/shared";

import type { SnippetIngestResult } from "../../ipc/contracts.ts";
import { encodeTextSnippet } from "./textSnippetContent.ts";

type IngestibleFile = Pick<File, "name" | "size" | "type">;

export function ingestTextSnippet(
  storageProvider: StorageProvider,
  text: string,
): Promise<SnippetIngestResult> | null {
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
  filePath?: string,
): Promise<SnippetIngestResult> {
  return window.ipc.snippets.ingest({
    id: crypto.randomUUID(),
    fileName: file.name,
    byteSize: file.size,
    mediaType: file.type || null,
    storageProvider,
    ...(filePath === undefined ? { file: file as File } : { filePath }),
  });
}
