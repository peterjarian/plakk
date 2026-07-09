import type { SnippetRow } from "@plakk/db/schema";
import type { ApiSnippet } from "@plakk/shared/PlakkApi";

export const toApiSnippet = (snippet: SnippetRow): ApiSnippet => ({
  id: snippet.id,
  kind: snippet.kind,
  title: snippet.title,
  fileName: snippet.fileName,
  byteSize: snippet.byteSize,
  contentType: snippet.contentType,
  storageProvider: snippet.storageProvider,
  uploadStatus: snippet.uploadStatus,
  createdAt: snippet.createdAt.toISOString(),
  updatedAt: snippet.updatedAt.toISOString(),
});
