import type { ClientSnapshot, Snippet } from "@plakk/client-runtime";
import {
  decodeSnippetText,
  deriveSnippetPresentation,
  isTextSnippetFileName,
  type StorageProvider,
} from "@plakk/shared";
import { accountCanSyncWithConnection } from "@plakk/shared/PlakkApi";
import type { SnippetRowData } from "@plakk/ui/components/SnippetRow";
import { Effect, Stream } from "effect";
import { useCallback, useEffect, useMemo } from "react";

import { downloadFile, sweepTemporaryDownloads } from "../lib/browserDownloads.ts";
import { collectBytes, type RunClient } from "../runtime/client.ts";
import { useSnippetPreviews } from "./useSnippetPreviews.ts";

const BUFFERED_CONTENT_MAX_BYTES = 64 * 1024 * 1024;

export type WebSnippet = SnippetRowData & {
  readonly id: string;
  readonly storageProvider: StorageProvider;
  readonly updatedAt: string;
  readonly presentation: ReturnType<typeof deriveSnippetPresentation>;
};

const projectSnippet = (snippet: Snippet, preview: string | undefined): WebSnippet => ({
  id: snippet.id,
  fileName: snippet.fileName,
  byteSize: snippet.byteSize,
  storageProvider: snippet.storageProvider,
  createdAt: snippet.createdAt,
  updatedAt: snippet.updatedAt,
  kind: snippet.status === "PUBLISHED" ? "PUBLISHED" : "LOCAL",
  localState:
    snippet.status === "PUBLISHED"
      ? null
      : {
          status: snippet.status === "FAILED" ? "FAILED" : "UPLOADING",
          errorMessage: snippet.status === "FAILED" ? snippet.errorMessage : null,
        },
  localContentAvailability: snippet.localContentAvailability,
  presentation:
    preview === undefined && isTextSnippetFileName(snippet.fileName)
      ? { type: "text", title: "Text snippet" }
      : deriveSnippetPresentation({
          fileName: snippet.fileName,
          ...(preview === undefined ? {} : { content: preview }),
        }),
});

export function useSnippets(snapshot: ClientSnapshot | null, run: RunClient) {
  const previews = useSnippetPreviews(snapshot, run);

  useEffect(() => {
    void sweepTemporaryDownloads().catch(() => {});
  }, []);

  const snippets = useMemo(
    () => snapshot?.snippets.map((snippet) => projectSnippet(snippet, previews[snippet.id])) ?? [],
    [previews, snapshot],
  );
  const capability =
    snapshot?.capability ??
    ({
      status: "OFFLINE",
      storageProvider: { known: false, value: null },
    } as const);
  const provider =
    capability.status === "ONLINE" &&
    accountCanSyncWithConnection(capability.account, capability.connection)
      ? capability.account.storageProvider
      : null;

  const readRemote = useCallback(
    (snippetId: string) => run((client) => collectBytes(client.content.readRemote(snippetId))),
    [run],
  );

  return {
    capability,
    snippets,
    syncStatus: snapshot?.syncStatus ?? null,
    addText: async (text: string) => {
      if (provider === null) throw new Error("Connect storage before adding snippets.");
      const bytes = new TextEncoder().encode(text);
      if (bytes.byteLength > BUFFERED_CONTENT_MAX_BYTES) {
        throw new Error("Web snippets cannot be larger than 64 MiB.");
      }
      const id = crypto.randomUUID();
      await run((client) =>
        client.uploads.upload(
          {
            id,
            fileName: `${id}.txt`,
            byteSize: bytes.byteLength,
            mediaType: "text/plain; charset=utf-8",
            storageProvider: provider,
          },
          {
            read: (offset, byteSize) => Effect.succeed(bytes.slice(offset, offset + byteSize)),
          },
        ),
      );
    },
    addFiles: async (files: ReadonlyArray<File>) => {
      if (provider === null) throw new Error("Connect storage before adding snippets.");
      await Promise.all(
        files.map((file) =>
          run((client) =>
            client.uploads.upload(
              {
                id: crypto.randomUUID(),
                fileName: file.name,
                byteSize: file.size,
                mediaType: file.type || null,
                storageProvider: provider,
              },
              {
                read: (offset, byteSize) =>
                  Effect.tryPromise(() =>
                    file
                      .slice(offset, offset + byteSize)
                      .arrayBuffer()
                      .then((buffer) => new Uint8Array(buffer)),
                  ),
              },
            ),
          ),
        ),
      );
    },
    deleteSnippet: (snippet: WebSnippet) =>
      run((client) =>
        snippet.kind === "LOCAL"
          ? client.snippets.dismissFailedUpload(snippet.id)
          : client.snippets.delete(snippet.id),
      ),
    copySnippet: async (snippet: WebSnippet) => {
      const text = previews[snippet.id];
      if (!isTextSnippetFileName(snippet.fileName)) {
        throw new Error("This snippet is not ready to copy.");
      }
      if (text !== undefined) {
        await navigator.clipboard.writeText(text);
        return;
      }
      if (snippet.byteSize > BUFFERED_CONTENT_MAX_BYTES) {
        throw new Error("This snippet is too large to open in the browser.");
      }
      const content = readRemote(snippet.id).then((bytes) => {
        const decoded = decodeSnippetText(bytes);
        if (decoded === null) throw new Error("This snippet is not valid UTF-8 text.");
        return new Blob([decoded], { type: "text/plain" });
      });
      await navigator.clipboard.write([new ClipboardItem({ "text/plain": content })]);
    },
    downloadSnippet: (snippet: WebSnippet) =>
      downloadFile(snippet.fileName, (write) =>
        run((client) =>
          client.content
            .readRemote(snippet.id)
            .pipe(
              Stream.runForEach((chunk) => Effect.tryPromise(() => write(Uint8Array.from(chunk)))),
            ),
        ),
      ),
  };
}
