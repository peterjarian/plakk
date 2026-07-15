import type { SnippetRow } from "@plakk/db/schema";
import type { ApiSnippet } from "@plakk/shared/PlakkApi";

export const toApiSnippet = (snippet: SnippetRow): ApiSnippet => ({
  id: snippet.id,
  kind: snippet.kind,
  title: snippet.kind === "TEXT" ? "Text snippet" : snippet.title,
  fileName: snippet.fileName,
  byteSize: snippet.byteSize,
  contentType: snippet.contentType,
  contentUrl: null,
  thumbnailUrl: null,
  textContent:
    snippet.kind === "TEXT" &&
    snippet.storageProvider === null &&
    snippet.storageObjectId === null &&
    new TextEncoder().encode(snippet.title).byteLength === snippet.byteSize
      ? snippet.title
      : null,
  storageProvider: snippet.storageProvider,
  uploadStatus: snippet.uploadStatus,
  uploadFailureMessage: snippet.uploadFailureMessage,
  createdAt: snippet.createdAt.toISOString(),
  updatedAt: snippet.updatedAt.toISOString(),
});
