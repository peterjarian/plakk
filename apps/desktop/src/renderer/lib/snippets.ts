import { useSyncExternalStore } from "react";
import {
  formatFileSize,
  isHttpUrl,
  SnippetSchema,
  snippetKindForFileName,
  type Snippet,
} from "@plakk/shared";
import { Schema } from "effect";
import { initialSnippets } from "../data/initialSnippets.ts";
import {
  mockCanAddSnippets,
  mockDroppedSnippetSubtitle,
  mockPastedImageTitle,
  mockSnippetStorageKey,
  mockSnippetUploadTickStorageKey,
  mockSyncedSnippetTime,
  mockUploadProgressStep,
  mockUploadTickMs,
} from "../data/mockSnippets.ts";
import type { ClipboardContent, TrayDroppedItem } from "../../ipc/contracts.ts";

const SnippetListSchema = Schema.Array(SnippetSchema);
const listeners = new Set<() => void>();
let cachedRaw: string | null | undefined;
let cachedSnippets = initialSnippets;

// Temporary renderer-only mock store. Effect atoms + SSE should replace this as the real
// sync path; keep IPC for native facts such as tray drops and file paths.
export const canAddSnippets = mockCanAddSnippets;

function readSnippets(): Snippet[] {
  const raw = window.localStorage.getItem(mockSnippetStorageKey);
  if (raw === cachedRaw) return cachedSnippets;

  cachedRaw = raw;
  if (raw === null) {
    cachedSnippets = initialSnippets;
    return cachedSnippets;
  }

  try {
    cachedSnippets = Array.from(Schema.decodeUnknownSync(SnippetListSchema)(JSON.parse(raw)));
  } catch {
    cachedSnippets = initialSnippets;
  }

  return cachedSnippets;
}

function writeSnippets(snippets: Snippet[]) {
  cachedSnippets = snippets;
  cachedRaw = JSON.stringify(snippets);
  window.localStorage.setItem(mockSnippetStorageKey, cachedRaw);
  for (const listener of listeners) listener();
}

function updateSnippets(updater: (current: Snippet[]) => Snippet[]) {
  const mutate = () => writeSnippets(updater(readSnippets()));
  if (navigator.locks) {
    void navigator.locks.request("plakk.snippets", mutate);
    return;
  }

  // ponytail: fallback is best-effort for old runtimes; real sync moves to Effect atoms + SSE.
  mutate();
}

export function useSnippets(): Snippet[] {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      const onStorage = (event: StorageEvent) => {
        if (event.key === mockSnippetStorageKey) listener();
      };
      window.addEventListener("storage", onStorage);

      return () => {
        listeners.delete(listener);
        window.removeEventListener("storage", onStorage);
      };
    },
    readSnippets,
    () => initialSnippets,
  );
}

export function addSnippet(snippet: Omit<Snippet, "id" | "time" | "synced">) {
  if (!canAddSnippets) return;

  updateSnippets((current) =>
    [
      { ...snippet, id: crypto.randomUUID(), time: mockSyncedSnippetTime, synced: true },
      ...current,
    ].slice(0, 20),
  );
}

export function addTextSnippet(value: string) {
  addSnippet(
    isHttpUrl(value)
      ? { title: value, subtitle: "", kind: "LINK" }
      : { title: value, subtitle: `${value.length} characters`, kind: "TEXT" },
  );
}

export function addFiles(files: FileList) {
  if (!canAddSnippets) return;

  const uploads: Snippet[] = Array.from(files).map((file) => ({
    id: crypto.randomUUID(),
    title: file.name,
    subtitle: `${file.name.split(".").pop()?.toUpperCase() ?? "FILE"} · ${formatFileSize(file.size)}`,
    kind: snippetKindForFileName(file.name),
    time: "",
    synced: false,
    uploadProgress: 0,
  }));

  updateSnippets((current) => [...uploads, ...current].slice(0, 20));
}

export function addDroppedData(dataTransfer: DataTransfer) {
  if (!canAddSnippets) return;

  if (dataTransfer.files.length) {
    addFiles(dataTransfer.files);
    return;
  }

  const dropped = dataTransfer.getData("text/plain").trim();
  if (dropped) addTextSnippet(dropped);
}

export function addTrayDroppedItem(item: TrayDroppedItem) {
  if (!canAddSnippets) return;

  if (item.type === "text") {
    const text = item.text.trim();
    if (text) addTextSnippet(text);
    return;
  }

  const snippets: Snippet[] = item.paths.map((path) => {
    const title = path.split(/[\\/]/).pop() || path;
    return {
      id: crypto.randomUUID(),
      title,
      subtitle: mockDroppedSnippetSubtitle,
      kind: snippetKindForFileName(title),
      time: "",
      synced: false,
      uploadProgress: 0,
    };
  });

  updateSnippets((current) => [...snippets, ...current].slice(0, 20));
}

export function addClipboardContent(content: ClipboardContent) {
  if (content.type === "text") {
    addTextSnippet(content.text);
    return;
  }

  if (content.type === "image") {
    addSnippet({
      title: mockPastedImageTitle,
      subtitle: `${content.width} x ${content.height}`,
      kind: "IMAGE",
    });
    return;
  }

  if (content.type === "empty") return;

  addSnippet({
    title: content.name,
    subtitle:
      content.size === undefined
        ? content.extension || "FILE"
        : `${content.extension || "FILE"} · ${formatFileSize(content.size)}`,
    kind: snippetKindForFileName(content.name),
  });
}

export function advanceUploads() {
  const now = Date.now();
  const lastTickAt = Number(window.localStorage.getItem(mockSnippetUploadTickStorageKey) ?? 0);
  if (now - lastTickAt < mockUploadTickMs) return;
  window.localStorage.setItem(mockSnippetUploadTickStorageKey, String(now));

  updateSnippets((current) =>
    current.map((snippet) => {
      if (snippet.uploadProgress === undefined) return snippet;

      const uploadProgress = Math.min(100, snippet.uploadProgress + mockUploadProgressStep);
      if (uploadProgress < 100) return { ...snippet, uploadProgress };

      const { uploadProgress: _uploadProgress, ...done } = snippet;
      return { ...done, synced: true, time: mockSyncedSnippetTime };
    }),
  );
}

export function deleteSnippet(id: string) {
  updateSnippets((current) => current.filter((snippet) => snippet.id !== id));
}
