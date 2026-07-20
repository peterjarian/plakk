import type { SnippetRow } from "@plakk/db/schema";
import type { ApiSnippet } from "@plakk/shared/PlakkApi";

export const toApiSnippet = (snippet: SnippetRow): ApiSnippet => ({
  id: snippet.id,
  fileName: snippet.fileName,
  byteSize: snippet.byteSize,
  storageProvider: snippet.storageProvider,
  storageObjectId: snippet.storageObjectId,
  createdAt: snippet.createdAt.toISOString(),
  updatedAt: snippet.updatedAt.toISOString(),
});
