import { useCallback, useEffect, useRef, useState } from "react";
import { ArrowUpRight, LoaderCircle, Plus, TriangleAlert } from "lucide-react";
import { deriveSnippetPresentation } from "@plakk/shared";
import type { DesktopSnippet } from "../../ipc/contracts.ts";
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
import { SnippetComposer } from "../components/SnippetComposer.tsx";
import { useAuth } from "../hooks/useAuth.ts";
import { useSnippetReplica } from "../hooks/useSnippetReplica.ts";
import { useSnippetThumbnails } from "../hooks/useSnippetThumbnails.ts";
import {
  StorageProviderIcon,
  storageProviderLabel,
  useStorageSetup,
  useStorageStatus,
} from "../hooks/useStorageStatus.tsx";
import { navigate } from "../lib/navigate.ts";
import { decodeTextSnippet, encodeTextSnippet } from "../lib/textSnippetContent.ts";

const accountSetupUrl = "https://app.plakk.io/account/setup";
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
  const [copyErrors, setCopyErrors] = useState<Record<string, string>>({});
  const [ingestError, setIngestError] = useState<string | null>(null);
  const [now, setNow] = useState(Date.now);
  const copiedTimerRef = useRef<number | undefined>(undefined);

  useEffect(() => {
    const interval = window.setInterval(() => setNow(Date.now()), 60 * 1000);
    return () => window.clearInterval(interval);
  }, []);

  const { isLoading: replicaLoading, items: replicaItems } = useSnippetReplica();
  const thumbnailUrls = useSnippetThumbnails(replicaItems);
  const snippets = replicaItems;
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
    if (storageStatus.kind !== "connected" || !storageStatus.canSync) {
      return;
    }
    const id = crypto.randomUUID();
    const bytes = encodeTextSnippet(text);
    if (bytes.byteLength === 0) return;
    const fileName = `${id}.txt`;
    const contentType = "text/plain; charset=utf-8";
    void ingestSnippet({
      id,
      fileName,
      byteSize: bytes.byteLength,
      mediaType: contentType,
      storageProvider: storageStatus.provider,
      bytes,
    });
  }

  function ingestSnippet(payload: Parameters<typeof window.ipc.snippets.ingest>[0]) {
    setIngestError(null);
    return window.ipc.snippets.ingest(payload).catch((error) => {
      setIngestError(error instanceof Error ? error.message : "Plakk couldn’t save this snippet.");
    });
  }

  const loadTextContent = useCallback(async (snippet: DesktopSnippet) => {
    setTextContents((contents) => ({ ...contents, [snippet.id]: { state: "loading" } }));
    try {
      const bytes = await window.ipc.snippets.read(snippet.id);
      const text = decodeTextSnippet(bytes);
      setTextContents((contents) => ({
        ...contents,
        [snippet.id]: { state: "ready", text },
      }));
    } catch (error) {
      const message = error instanceof Error ? error.message : "Could not load this text snippet.";
      setTextContents((contents) => ({
        ...contents,
        [snippet.id]: { state: "failed", message },
      }));
    }
  }, []);

  useEffect(() => {
    for (const snippet of replicaItems) {
      if (snippet.localTextContent !== null) {
        const current = textContents[snippet.id];
        if (current?.state !== "ready" || current.text !== snippet.localTextContent) {
          setTextContents((contents) => ({
            ...contents,
            [snippet.id]: { state: "ready", text: snippet.localTextContent! },
          }));
        }
        continue;
      }
      if (
        deriveSnippetPresentation({ fileName: snippet.fileName }).type === "text" &&
        snippet.uploadStatus === "UPLOADED" &&
        textContents[snippet.id] === undefined
      ) {
        void loadTextContent(snippet);
      }
    }
  }, [loadTextContent, replicaItems, textContents]);

  function enqueueFileSnippet(file: Pick<File, "name" | "size" | "type">, filePath?: string) {
    if (storageStatus.kind !== "connected" || !storageStatus.canSync) return;

    const id = crypto.randomUUID();
    void ingestSnippet({
      id,
      byteSize: file.size,
      mediaType: file.type || null,
      fileName: file.name,
      storageProvider: storageStatus.provider,
      ...(filePath === undefined ? { file: file as File } : { filePath }),
    });
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
        )
        .catch((error) => {
          setIngestError(
            error instanceof Error ? error.message : "Plakk couldn’t read the pasted image.",
          );
        });
      return;
    }

    if (content.type === "file" && content.size !== undefined) {
      enqueueFileSnippet({ name: content.name, size: content.size, type: "" }, content.path);
    }
  }

  function cancelUpload(id: string) {
    void runSnippetAction(id, () => window.ipc.snippets.cancel(id));
  }

  function runSnippetAction(id: string, action: () => Promise<void>) {
    setCopyErrors((errors) => {
      const { [id]: _error, ...remaining } = errors;
      return remaining;
    });
    return action().catch((error) => {
      setCopyErrors((errors) => ({
        ...errors,
        [id]: error instanceof Error ? error.message : "Plakk couldn’t update this snippet.",
      }));
    });
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
      deriveSnippetPresentation({ fileName: snippet.fileName }).type !== "text" &&
      !snippet.fileName.toLowerCase().endsWith(".txt");
    try {
      if (needsCopySpinner) setCopyingId(snippet.id);

      await window.ipc.snippets.copy(snippet.id);

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
    return () => {
      if (copiedTimerRef.current !== undefined) window.clearTimeout(copiedTimerRef.current);
    };
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
  }, [accountBlocked, active, storageStatus]);

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
          {ingestError !== null && (
            <p className="mt-2 text-xs text-destructive" role="alert">
              {ingestError}
            </p>
          )}
        </div>

        {replicaLoading && snippets.length === 0 ? (
          <div
            className="grid min-h-0 flex-1 place-items-center text-muted-foreground"
            role="status"
          >
            <LoaderCircle className="size-5 animate-spin" aria-hidden="true" />
            <span className="sr-only">Loading snippets</span>
          </div>
        ) : (
          <SnippetList empty={snippets.length === 0}>
            {snippets.map((snippet) => (
              <SnippetRow
                key={snippet.id}
                snippet={snippet}
                now={now}
                copied={copiedId === snippet.id}
                copying={copyingId === snippet.id}
                onCopy={() => void copySnippet(snippet)}
                copyDisabled={!snippet.contentAvailable && snippet.uploadStatus !== "UPLOADED"}
                copyError={copyErrors[snippet.id]}
                onDelete={() => {
                  void runSnippetAction(snippet.id, () => window.ipc.snippets.delete(snippet.id));
                }}
                onRetryUpload={() =>
                  void runSnippetAction(snippet.id, () => window.ipc.snippets.retry(snippet.id))
                }
                onOpenLink={openLink}
                {...(deriveSnippetPresentation({ fileName: snippet.fileName }).type === "text"
                  ? {
                      textContent: textContents[snippet.id],
                      onRetryContent: () => void loadTextContent(snippet),
                    }
                  : {})}
                {...(deriveSnippetPresentation({ fileName: snippet.fileName }).type === "image"
                  ? {
                      thumbnailUrl: thumbnailUrls[snippet.id] ?? null,
                    }
                  : {})}
                onStopUpload={() => cancelUpload(snippet.id)}
              />
            ))}
          </SnippetList>
        )}
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
