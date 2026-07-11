import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ArrowUpRight, Plus, TriangleAlert } from "lucide-react";
import { useAtomSet, useAtomValue } from "@effect/atom-react";
import { snippetKindForFileName } from "@plakk/shared";
import type { ApiSnippet } from "@plakk/shared/PlakkApi";
import {
  deleteSnippetOptions,
  emptySnippetsAtom,
  snippetReactivityKeys,
  type SnippetRequestHeaders,
} from "@plakk/ui/atoms/snippets";
import { createPlakkRpc } from "@plakk/ui/atoms/rpc";
import { AppHeader } from "@plakk/ui/components/AppHeader";
import { SnippetList } from "@plakk/ui/components/SnippetList";
import { SnippetRow } from "@plakk/ui/components/SnippetRow";
import type { TextSnippetContent } from "@plakk/ui/components/SnippetRow";
import { Button } from "@plakk/ui/components/primitives/button";
import { Checkbox } from "@plakk/ui/components/primitives/checkbox";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@plakk/ui/components/primitives/dialog";
import { useActiveUploadTasks, useUploadActions } from "@plakk/ui/hooks/useUploadFlow";
import { AsyncResult, Atom } from "effect/unstable/reactivity";
import { SnippetComposer } from "../components/SnippetComposer.tsx";
import { useAuth } from "../hooks/useAuth.ts";
import {
  StorageProviderIcon,
  storageProviderLabel,
  useStorageSetup,
  useStorageStatus,
} from "../hooks/useStorageStatus.tsx";
import { navigate } from "../lib/navigate.ts";
import { cancelStoredSnippetUpload, uploadStoredSnippet } from "../lib/storedSnippetUpload.ts";
import { decodeTextSnippet, encodeTextSnippet } from "../lib/textSnippetContent.ts";

const accountSetupUrl = "https://app.plakk.io/account/setup";
const plakkRpc = createPlakkRpc(window.ipc.runtimeConfig.plakkRpcUrl);
const deleteSnippetMutationAtom = plakkRpc.mutation("DeleteSnippet");
const prepareStoredSnippetUploadMutationAtom = plakkRpc.mutation("PrepareStoredSnippetUpload");
const createStoredSnippetMutationAtom = plakkRpc.mutation("CreateStoredSnippet");
const updateStoredSnippetUploadStatusMutationAtom = plakkRpc.mutation(
  "UpdateStoredSnippetUploadStatus",
);
const listSnippetsQuery = (headers: SnippetRequestHeaders, contentUrlGeneration: number) =>
  plakkRpc.query(
    "ListSnippets",
    { limit: 20 },
    {
      headers,
      reactivityKeys: snippetReactivityKeys,
      serializationKey: `latest-${contentUrlGeneration}`,
    },
  );

export function Home({ active = true }: { active?: boolean }) {
  const auth = useAuth();
  const storageStatus = useStorageStatus();
  const openStorageSetup = useStorageSetup();
  const [isDragging, setIsDragging] = useState(false);
  const [copiedId, setCopiedId] = useState<string | null>(null);
  const [copyingId, setCopyingId] = useState<string | null>(null);
  const [pendingExternalUrl, setPendingExternalUrl] = useState<string | null>(null);
  const [skipExternalLinkWarning, setSkipExternalLinkWarning] = useState(false);
  const [showExternalLinkWarning, setShowExternalLinkWarning] = useState(true);
  const [textContents, setTextContents] = useState<Record<string, TextSnippetContent>>({});
  const [thumbnailUrls, setThumbnailUrls] = useState<Record<string, string>>({});
  const [copyErrors, setCopyErrors] = useState<Record<string, string>>({});
  const [contentUrlGeneration, setContentUrlGeneration] = useState(0);
  const [now, setNow] = useState(Date.now);
  const copiedTimerRef = useRef<number | undefined>(undefined);

  useEffect(() => {
    const interval = window.setInterval(() => setNow(Date.now()), 60 * 1000);
    return () => window.clearInterval(interval);
  }, []);

  const snippetHeaders = useMemo<SnippetRequestHeaders | null>(
    () => (auth.accessToken === null ? null : { authorization: `Bearer ${auth.accessToken}` }),
    [auth.accessToken],
  );
  const snippetsAtom = useMemo(() => {
    const source =
      snippetHeaders === null
        ? (emptySnippetsAtom as Atom.Atom<Atom.Type<ReturnType<typeof listSnippetsQuery>>>)
        : listSnippetsQuery(snippetHeaders, contentUrlGeneration);
    return Atom.optimistic(source);
  }, [contentUrlGeneration, snippetHeaders]);
  const snippetsResult = useAtomValue(snippetsAtom);
  const syncedSnippetResponse = AsyncResult.getOrElse(snippetsResult, () => ({
    items: [] as ReadonlyArray<ApiSnippet>,
  }));
  const deleteSyncedSnippetAtom = useMemo(
    () =>
      Atom.optimisticFn(snippetsAtom, {
        reducer: (result, { payload }) =>
          AsyncResult.map(result, (response) => ({
            ...response,
            items: response.items.filter((snippet) => snippet.id !== payload.id),
          })),
        fn: deleteSnippetMutationAtom,
      }),
    [snippetsAtom],
  );
  const deleteSyncedSnippet = useAtomSet(deleteSyncedSnippetAtom, { mode: "promise" });
  const prepareStoredSnippetUpload = useAtomSet(prepareStoredSnippetUploadMutationAtom, {
    mode: "promise",
  });
  const createStoredSnippet = useAtomSet(createStoredSnippetMutationAtom, { mode: "promise" });
  const updateStoredSnippetUploadStatus = useAtomSet(updateStoredSnippetUploadStatusMutationAtom, {
    mode: "promise",
  });
  const uploadActions = useUploadActions();
  const uploadTasks = useActiveUploadTasks();
  const snippets = [
    ...uploadTasks,
    ...syncedSnippetResponse.items.filter(
      (snippet) => !uploadTasks.some((task) => task.id === snippet.id),
    ),
  ];
  const accountBlocked = !storageStatus.canSync;
  const user = auth.user;
  const syncPausedMessage =
    storageStatus.kind === "failed"
      ? "Storage status is unavailable. Try again shortly."
      : storageStatus.kind === "connected" &&
          storageStatus.account.blockedReasons.includes("billing")
        ? "Sync paused. Finish billing to add snippets."
        : storageStatus.kind === "connected"
          ? "Sync is currently paused."
          : storageStatus.kind === "needs-reauthorization"
            ? `Sync paused. Reconnect ${storageProviderLabel(storageStatus.provider)} to add snippets.`
            : "Sync paused. Finish storage setup to add snippets.";
  const syncSetupUrl =
    storageStatus.kind === "unlinked" || storageStatus.kind === "needs-reauthorization"
      ? storageStatus.actionUrl
      : accountSetupUrl;

  function addTextSnippet(text: string) {
    if (snippetHeaders === null || storageStatus.kind !== "connected" || !storageStatus.canSync) {
      return;
    }
    const id = crypto.randomUUID();
    const bytes = encodeTextSnippet(text);
    if (bytes.byteLength === 0) return;
    const fileName = `${id}.txt`;
    const contentType = "text/plain; charset=utf-8";
    const task = uploadActions.enqueue({
      id,
      fileName,
      byteSize: bytes.byteLength,
      contentType,
      kind: "TEXT",
      storageProvider: storageStatus.provider,
    });
    void uploadStoredSnippet({
      file: { name: fileName, size: bytes.byteLength, type: contentType },
      bytes,
      task,
      actions: uploadActions,
      uploader: window.ipc.storage,
      api: {
        prepare: (payload) =>
          prepareStoredSnippetUpload({
            headers: snippetHeaders,
            payload,
            reactivityKeys: snippetReactivityKeys,
          }),
        create: (payload) =>
          createStoredSnippet({
            headers: snippetHeaders,
            payload,
            reactivityKeys: snippetReactivityKeys,
          }),
        updateStatus: (payload) =>
          updateStoredSnippetUploadStatus({
            headers: snippetHeaders,
            payload,
            reactivityKeys: snippetReactivityKeys,
          }),
      },
    }).catch(() => undefined);
  }

  const loadTextContent = useCallback(
    async (snippet: ApiSnippet) => {
      if (snippetHeaders === null) return;
      setTextContents((contents) => ({ ...contents, [snippet.id]: { state: "loading" } }));
      try {
        let bytes: Uint8Array;
        if (snippet.contentUrl === null) {
          if (snippet.textContent === null) throw new Error("Snippet content is unavailable.");
          bytes = encodeTextSnippet(snippet.textContent ?? "");
        } else {
          const response = await fetch(snippet.contentUrl);
          if (!response.ok) throw new Error(`Snippet download failed: ${response.status}`);
          bytes = new Uint8Array(await response.arrayBuffer());
        }
        const text = decodeTextSnippet(bytes);
        setTextContents((contents) => ({
          ...contents,
          [snippet.id]: { state: "ready", text },
        }));

        if (snippet.storageProvider === null) {
          if (storageStatus.kind !== "connected" || !storageStatus.canSync) {
            setTextContents((contents) => ({
              ...contents,
              [snippet.id]: {
                state: "ready",
                text,
                migrationError: "Reconnect storage to finish moving this snippet.",
              },
            }));
            return;
          }

          try {
            const prepared = await prepareStoredSnippetUpload({
              headers: snippetHeaders,
              payload: {
                snippetId: snippet.id,
                storageProvider: storageStatus.provider,
              },
              reactivityKeys: snippetReactivityKeys,
            });
            const uploaded = await window.ipc.storage.uploadPreparedFile({
              id: snippet.id,
              prepared,
              byteSize: bytes.byteLength,
              bytes,
            });
            await updateStoredSnippetUploadStatus({
              headers: snippetHeaders,
              payload: {
                id: snippet.id,
                uploadStatus: "READY",
                storageProvider: storageStatus.provider,
                storageObjectId: uploaded.storageObjectId,
              },
              reactivityKeys: snippetReactivityKeys,
            });
          } catch {
            setTextContents((contents) => ({
              ...contents,
              [snippet.id]: {
                state: "ready",
                text,
                migrationError: "Could not move this legacy snippet to cloud storage. Retry.",
              },
            }));
          }
        }
      } catch (error) {
        const message =
          error instanceof Error ? error.message : "Could not load this text snippet.";
        setTextContents((contents) => ({
          ...contents,
          [snippet.id]: { state: "failed", message },
        }));
      }
    },
    [prepareStoredSnippetUpload, snippetHeaders, storageStatus, updateStoredSnippetUploadStatus],
  );

  useEffect(() => {
    for (const snippet of syncedSnippetResponse.items) {
      if (
        snippet.kind === "TEXT" &&
        snippet.uploadStatus === "READY" &&
        textContents[snippet.id] === undefined
      ) {
        void loadTextContent(snippet);
      }
    }
  }, [loadTextContent, syncedSnippetResponse.items, textContents]);

  useEffect(() => {
    let cancelled = false;
    const urls: string[] = [];

    void Promise.all(
      syncedSnippetResponse.items
        .filter(
          (snippet) =>
            snippet.kind === "IMAGE" &&
            snippet.uploadStatus === "READY" &&
            snippet.storageProvider === "GOOGLE_DRIVE",
        )
        .map(async (snippet) => {
          try {
            const bytes = await window.ipc.snippets.read(snippet.id);
            if (cancelled) return;
            const url = URL.createObjectURL(
              new Blob([Uint8Array.from(bytes)], {
                type: snippet.contentType ?? "application/octet-stream",
              }),
            );
            urls.push(url);
            setThumbnailUrls((current) => ({ ...current, [snippet.id]: url }));
          } catch {
            // The image icon remains visible when preview loading fails.
          }
        }),
    );

    return () => {
      cancelled = true;
      for (const url of urls) URL.revokeObjectURL(url);
      setThumbnailUrls({});
    };
  }, [syncedSnippetResponse.items]);

  function enqueueFileSnippet(file: Pick<File, "name" | "size" | "type">, filePath?: string) {
    if (storageStatus.kind !== "connected" || !storageStatus.canSync) return;

    const kind = snippetKindForFileName(file.name);
    if (kind !== "FILE" && kind !== "IMAGE") return;

    const task = uploadActions.enqueue({
      byteSize: file.size,
      contentType: file.type || null,
      fileName: file.name,
      kind,
      storageProvider: storageStatus.provider,
    });
    if (snippetHeaders === null) return;

    void uploadStoredSnippet({
      file,
      ...(filePath === undefined ? {} : { filePath }),
      task,
      actions: uploadActions,
      uploader: window.ipc.storage,
      api: {
        prepare: (payload) =>
          prepareStoredSnippetUpload({
            headers: snippetHeaders,
            payload,
            reactivityKeys: snippetReactivityKeys,
          }),
        create: (payload) =>
          createStoredSnippet({
            headers: snippetHeaders,
            payload,
            reactivityKeys: snippetReactivityKeys,
          }),
        updateStatus: (payload) =>
          updateStoredSnippetUploadStatus({
            headers: snippetHeaders,
            payload,
            reactivityKeys: snippetReactivityKeys,
          }),
      },
    }).catch(() => undefined);
  }

  function handleClipboardPaste(
    content: Parameters<Parameters<typeof window.ipc.clipboard.onPaste>[0]>[0],
  ) {
    if (accountBlocked) return;

    if (content.type === "text") {
      addTextSnippet(content.text);
      return;
    }

    if (content.type === "image") {
      void fetch(content.dataUrl)
        .then((response) => response.blob())
        .then((blob) =>
          enqueueFileSnippet(
            new File([blob], "Pasted image.png", { type: blob.type }),
            content.path,
          ),
        );
      return;
    }

    if (content.type === "file" && content.size !== undefined) {
      enqueueFileSnippet({ name: content.name, size: content.size, type: "" }, content.path);
    }
  }

  function cancelUpload(id: string) {
    cancelStoredSnippetUpload(id);
    void window.ipc.storage.cancelUpload(id);
  }

  function showCopied(id: string) {
    setCopiedId(id);
    if (copiedTimerRef.current !== undefined) window.clearTimeout(copiedTimerRef.current);
    copiedTimerRef.current = window.setTimeout(() => {
      setCopiedId((copied) => (copied === id ? null : copied));
    }, 1200);
  }

  async function copySnippet(snippet: (typeof snippets)[number]) {
    const needsCopySpinner =
      (snippet.kind === "FILE" || snippet.kind === "IMAGE") &&
      !snippet.fileName.toLowerCase().endsWith(".txt");
    try {
      if ("phase" in snippet) throw new Error("Finish uploading before copying this snippet.");

      if (needsCopySpinner) setCopyingId(snippet.id);

      if (snippet.kind === "FILE" || snippet.kind === "IMAGE") {
        if (snippet.contentUrl === null || snippet.storageProvider === null) {
          throw new Error("Snippet download is unavailable.");
        }
        await window.ipc.snippets.copy(snippet.id);
      } else {
        const textContent = textContents[snippet.id];
        const text =
          snippet.kind === "TEXT"
            ? textContent?.state === "ready"
              ? textContent.text
              : null
            : snippet.title;
        if (text === null) return;
        if (navigator.clipboard === undefined) throw new Error("Clipboard access is unavailable.");
        await navigator.clipboard.writeText(text);
      }

      setCopyErrors((errors) => {
        const { [snippet.id]: _error, ...remaining } = errors;
        return remaining;
      });
      showCopied(snippet.id);
    } catch (error) {
      setCopyErrors((errors) => ({
        ...errors,
        [snippet.id]: error instanceof Error ? error.message : "Could not copy this snippet.",
      }));
    } finally {
      if (needsCopySpinner) setCopyingId((id) => (id === snippet.id ? null : id));
    }
  }

  useEffect(() => {
    return window.ipc.storage.onProgress(({ id, progress }) =>
      uploadActions.setProgress(id, progress),
    );
  }, [uploadActions]);

  useEffect(() => {
    return () => {
      if (copiedTimerRef.current !== undefined) window.clearTimeout(copiedTimerRef.current);
    };
  }, []);

  useEffect(() => {
    const refresh = window.setInterval(
      () => {
        setContentUrlGeneration((generation) => generation + 1);
      },
      30 * 60 * 1000,
    );
    return () => window.clearInterval(refresh);
  }, []);

  useEffect(() => {
    window.ipc.userConfig.get().then(
      (config) => setShowExternalLinkWarning(config.showExternalLinkWarning),
      () => setShowExternalLinkWarning(true),
    );
  }, []);

  useEffect(() => {
    if (!active) return;
    return window.ipc.clipboard.onPaste((content) => handleClipboardPaste(content));
  }, [accountBlocked, active, snippetHeaders, storageStatus, uploadActions]);

  function openLink(url: string) {
    if (!showExternalLinkWarning) {
      void window.ipc.openExternal(url);
      return;
    }

    setSkipExternalLinkWarning(false);
    setPendingExternalUrl(url);
  }

  function closeExternalLinkDialog() {
    setPendingExternalUrl(null);
    setSkipExternalLinkWarning(false);
  }

  async function confirmExternalLink() {
    if (!pendingExternalUrl) return;

    const url = pendingExternalUrl;
    closeExternalLinkDialog();

    if (skipExternalLinkWarning) {
      setShowExternalLinkWarning(false);
      await window.ipc.userConfig.set({ showExternalLinkWarning: false });
    }

    await window.ipc.openExternal(url);
  }

  const pendingExternalHost = pendingExternalUrl ? new URL(pendingExternalUrl).host : "";

  const storageAction =
    storageStatus.kind === "unlinked" ? (
      <Button
        type="button"
        variant="ghost"
        size="sm"
        aria-label="Set up storage"
        toolTip="Set up storage"
        onClick={() => openStorageSetup(storageStatus.actionUrl)}
      >
        Set up storage
        <ArrowUpRight className="text-muted-foreground" />
      </Button>
    ) : storageStatus.kind === "needs-reauthorization" ? (
      <Button
        type="button"
        variant="ghost"
        size="sm"
        aria-label={`Reconnect ${storageProviderLabel(storageStatus.provider)}`}
        toolTip="Reconnect storage"
        onClick={() => openStorageSetup(storageStatus.actionUrl)}
      >
        <StorageProviderIcon provider={storageStatus.provider} className="size-4" />
        {storageProviderLabel(storageStatus.provider)}
        <ArrowUpRight className="text-muted-foreground" />
      </Button>
    ) : storageStatus.kind === "connected" ? (
      <Button
        type="button"
        variant="ghost"
        size="sm"
        aria-label={`Open ${storageProviderLabel(storageStatus.provider)} in browser`}
        toolTip={`Open ${storageProviderLabel(storageStatus.provider)}`}
        onClick={() => void window.ipc.openExternal(storageStatus.destinationUrl)}
      >
        <StorageProviderIcon provider={storageStatus.provider} className="size-4" />
        {storageProviderLabel(storageStatus.provider)}
        <ArrowUpRight className="text-muted-foreground" />
      </Button>
    ) : null;

  if (user === null) return null;

  return (
    <main
      className="flex h-screen flex-col overflow-hidden bg-background text-foreground"
      aria-label="Plakk"
      onDragEnter={() => {
        if (!accountBlocked) setIsDragging(true);
      }}
      onDragOver={(event) => {
        event.preventDefault();
        if (accountBlocked) return;
        setIsDragging(true);
      }}
      onDragLeave={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setIsDragging(false);
      }}
      onDrop={(event) => {
        event.preventDefault();
        setIsDragging(false);
        if (accountBlocked) return;

        if (event.dataTransfer.files.length) {
          for (const file of Array.from(event.dataTransfer.files)) {
            enqueueFileSnippet(file);
          }
          return;
        }

        const dropped = event.dataTransfer.getData("text/plain").trim();
        if (dropped) addTextSnippet(dropped);
      }}
    >
      <div className="drag-region h-12" aria-hidden="true" />

      <AppHeader
        user={user}
        onSettingsClick={() => navigate("settings")}
        onSignOutClick={() => void auth.signOut().then(() => navigate("welcome"))}
        storageAction={storageAction}
      />

      <div className="scrollbar-hidden flex min-h-0 flex-1 flex-col overflow-y-auto px-6 pb-4">
        <div className="sticky top-0 z-20 bg-background pt-3 pb-5">
          {accountBlocked && storageStatus.kind !== "loading" && (
            <div className="mb-2 flex items-center gap-2 rounded-md bg-muted px-2.5 py-1.5 text-xs text-muted-foreground">
              <TriangleAlert className="size-3.5 shrink-0 text-amber-600" aria-hidden="true" />
              <span className="min-w-0 flex-1 truncate">{syncPausedMessage}</span>
              {storageStatus.kind !== "failed" && (
                <Button
                  type="button"
                  variant="ghost"
                  size="xs"
                  onClick={() => openStorageSetup(syncSetupUrl)}
                >
                  Finish on web
                  <ArrowUpRight />
                </Button>
              )}
            </div>
          )}
          <SnippetComposer
            disabled={accountBlocked}
            onSubmit={addTextSnippet}
            onFiles={(files) => {
              if (accountBlocked) return;

              for (const file of Array.from(files)) {
                enqueueFileSnippet(file);
              }
            }}
          />
        </div>

        <SnippetList empty={snippets.length === 0}>
          {snippets.map((snippet) => (
            <SnippetRow
              key={snippet.id}
              snippet={snippet}
              now={now}
              copied={copiedId === snippet.id}
              copying={copyingId === snippet.id}
              onCopy={() => void copySnippet(snippet)}
              copyDisabled={"phase" in snippet}
              copyError={copyErrors[snippet.id]}
              onDelete={() => {
                if ("phase" in snippet) {
                  if (snippet.phase === "FAILED") uploadActions.remove(snippet.id);
                  else cancelUpload(snippet.id);
                  return;
                }
                if (snippetHeaders !== null) {
                  void deleteSyncedSnippet(deleteSnippetOptions(snippetHeaders, snippet.id));
                }
              }}
              {...(snippet.kind === "LINK" ? { onOpenLink: openLink } : {})}
              {...(snippet.kind === "TEXT" && !("phase" in snippet)
                ? {
                    textContent: textContents[snippet.id],
                    onRetryContent: () => void loadTextContent(snippet),
                  }
                : {})}
              {...(snippet.kind === "IMAGE" && !("phase" in snippet)
                ? {
                    thumbnailUrl:
                      snippet.storageProvider === "GOOGLE_DRIVE"
                        ? (thumbnailUrls[snippet.id] ?? null)
                        : snippet.thumbnailUrl,
                  }
                : {})}
              onStopUpload={() => cancelUpload(snippet.id)}
            />
          ))}
        </SnippetList>
      </div>

      {isDragging && (
        <div className="pointer-events-none fixed inset-0 z-50 flex items-center justify-center bg-blue-500/15">
          <div className="flex size-8 items-center justify-center rounded-full bg-blue-500 text-white shadow-sm">
            <Plus className="size-5" />
          </div>
        </div>
      )}

      <Dialog
        open={pendingExternalUrl !== null}
        onOpenChange={(open) => {
          if (!open) closeExternalLinkDialog();
        }}
      >
        <DialogContent className="w-[min(calc(100%-2rem),24rem)]">
          <DialogHeader>
            <div className="flex items-start gap-3">
              <div className="mt-0.5 flex size-8 shrink-0 items-center justify-center rounded-lg bg-amber-100 text-amber-700 dark:bg-amber-400/15 dark:text-amber-300">
                <TriangleAlert className="size-4" aria-hidden="true" />
              </div>
              <div className="grid gap-2">
                <DialogTitle>Open external link?</DialogTitle>
                <DialogDescription>
                  This link will open in your browser outside Plakk.
                </DialogDescription>
              </div>
            </div>
          </DialogHeader>

          <div className="grid gap-3">
            <div className="rounded-lg border border-amber-300/70 bg-amber-50/70 px-3 py-2 text-sm dark:border-amber-400/25 dark:bg-amber-400/10">
              <p className="truncate font-medium">{pendingExternalHost}</p>
              <p className="truncate text-xs text-muted-foreground">{pendingExternalUrl}</p>
            </div>

            <label className="flex items-center gap-2 text-sm">
              <Checkbox
                checked={skipExternalLinkWarning}
                onCheckedChange={(checked) => setSkipExternalLinkWarning(checked === true)}
              />
              Do not warn me again
            </label>
          </div>

          <DialogFooter className="flex-row justify-end">
            <Button type="button" variant="outline" onClick={closeExternalLinkDialog}>
              Cancel
            </Button>
            <Button type="button" onClick={() => void confirmExternalLink()}>
              Open link
              <ArrowUpRight />
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </main>
  );
}
