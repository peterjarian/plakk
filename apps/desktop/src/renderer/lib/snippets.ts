import { formatFileSize, isHttpUrl, type Snippet } from "@plakk/shared";
import type { ApiSnippet } from "@plakk/shared/PlakkApi";

export function errorMessage(error: unknown, fallback: string) {
  return error instanceof Error ? error.message : fallback;
}

export function apiSnippetToSnippet(snippet: ApiSnippet): Snippet {
  const kind: Snippet["kind"] =
    snippet.kind === "TEXT" && isHttpUrl(snippet.title) ? "LINK" : snippet.kind;

  return {
    id: snippet.id,
    title: snippet.title,
    subtitle:
      snippet.kind === "TEXT"
        ? isHttpUrl(snippet.title)
          ? ""
          : formatFileSize(snippet.byteSize)
        : `${snippet.fileName.split(".").pop()?.toUpperCase() ?? "FILE"} · ${formatFileSize(snippet.byteSize)}`,
    kind,
    time: "now",
    synced: snippet.uploadStatus === "READY",
    ...(snippet.uploadStatus === "UPLOADING" ? { uploadProgress: 0 } : {}),
  };
}

export function optimisticTextSnippet(id: string, value: string): Snippet {
  return {
    id,
    title: value,
    subtitle: isHttpUrl(value) ? "" : `${value.length} characters`,
    kind: isHttpUrl(value) ? "LINK" : "TEXT",
    time: "now",
    synced: false,
  };
}

export function snippetClipboardText(snippet: Snippet) {
  return snippet.kind === "TEXT" || snippet.kind === "LINK"
    ? snippet.title
    : snippet.subtitle || snippet.title;
}
