import { useState } from "react";
import type { AccountStatus } from "@plakk/shared/PlakkApi";

import type { ClipboardContent, TrayDroppedItem } from "../../../ipc/contracts.ts";
import { useSnippets } from "../../hooks/useSnippets.ts";
import { encodeTextSnippet } from "../../lib/textSnippetContent.ts";

export function useTraySnippets(account: AccountStatus | null) {
  const { error: snippetReadError, items, reload: reloadSnippets } = useSnippets();
  const [error, setError] = useState<string | null>(null);
  const latest = items.at(0);
  const provider = account?.storageProvider ?? null;

  const ingest = (payload: Parameters<typeof window.ipc.snippets.ingest>[0]) => {
    setError(null);
    return window.ipc.snippets.ingest(payload).then(
      (result) => {
        if (result.status === "FAILED") setError(result.message);
      },
      () => setError("Plakk couldn’t save this snippet."),
    );
  };

  const upload = (file: Pick<File, "name" | "size" | "type">, filePath?: string) => {
    if (provider === null) return;
    void ingest({
      id: crypto.randomUUID(),
      fileName: file.name,
      byteSize: file.size,
      mediaType: file.type || null,
      storageProvider: provider,
      ...(filePath === undefined ? { file: file as File } : { filePath }),
    });
  };

  const addText = (text: string) => {
    if (provider === null) return;
    const bytes = encodeTextSnippet(text.trim());
    if (bytes.byteLength === 0) return;
    const id = crypto.randomUUID();
    void ingest({
      id,
      fileName: `${id}.txt`,
      byteSize: bytes.byteLength,
      mediaType: "text/plain; charset=utf-8",
      storageProvider: provider,
      bytes,
    });
  };

  const addClipboard = async (content: ClipboardContent) => {
    try {
      if (content.type === "text") addText(content.text);
      else if (content.type === "image") {
        const blob = await fetch(content.dataUrl).then((response) => response.blob());
        upload({ name: "Pasted image.png", size: blob.size, type: blob.type }, content.path);
      } else if (content.type === "file" && content.size !== undefined)
        upload({ name: content.name, size: content.size, type: "" }, content.path);
    } catch {
      setError("Plakk couldn’t read the clipboard item.");
    }
  };

  const addDropped = (item: TrayDroppedItem) => {
    if (item.type === "text") addText(item.text);
    else
      for (const file of item.files)
        upload({ name: file.name, size: file.size, type: "" }, file.path);
  };

  return {
    addClipboard,
    addDropped,
    addText,
    error,
    latest,
    reloadSnippets,
    reportError: setError,
    snippetReadError,
    upload,
  };
}
