import { useEffect, useState, type DragEvent } from "react";
import type { ClipboardContent, TrayDroppedItem } from "../../ipc/contracts.ts";
import { useAuth } from "../hooks/useAuth.ts";
import { useSnippets } from "../hooks/useSnippets.ts";
import { useLocalState } from "../hooks/useLocalState.tsx";
import {
  StorageProviderIcon,
  storageProviderLabel,
  useLinkedStorageProvider,
  useStorageStatus,
} from "../hooks/useStorageStatus.tsx";
import { ipcActionErrorMessage } from "../lib/ipcActionErrorMessage.ts";
import { ingestFileSnippet, ingestTextSnippet } from "../lib/snippetIngestion.ts";
import { SyncStatusIndicator, type SyncStatus } from "../components/SyncStatusIndicator.tsx";
import { TrayActions } from "./tray/TrayActions.tsx";
import { TrayRecentItem } from "./tray/TrayRecentItem.tsx";
import { TrayShell } from "./tray/TrayShell.tsx";

export function Tray() {
  const [isDragging, setIsDragging] = useState(false);
  const [copiedId, setCopiedId] = useState<string | null>(null);
  const [copyingId, setCopyingId] = useState<string | null>(null);
  const [copyError, setCopyError] = useState<{ id: string; message: string } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const auth = useAuth();
  const provider = useLinkedStorageProvider();
  const storageStatus = useStorageStatus();
  const liveConnection = useLocalState().localState.liveConnection;
  const ingestionAllowed = storageStatus.kind === "connected" && storageStatus.canSync;
  const syncStatus: SyncStatus =
    storageStatus.kind === "loading"
      ? "CHECKING"
      : storageStatus.kind === "offline" || storageStatus.kind === "failed"
        ? "OFFLINE"
        : storageStatus.kind !== "connected" || !storageStatus.canSync
          ? "PAUSED"
          : liveConnection?.status === "CONNECTED"
            ? "CONNECTED"
            : "RECONNECTING";
  const ingestionProvider = storageStatus.kind === "connected" ? storageStatus.provider : null;
  const { error: snippetReadError, items, reload: reloadSnippets } = useSnippets();
  const latest = items.at(0);
  const copyDisabled =
    latest === undefined ||
    latest.kind !== "PUBLISHED" ||
    latest.localContentAvailability.status !== "AVAILABLE";
  const isCopied = latest !== undefined && copiedId === latest.id;
  const isCopying = latest !== undefined && copyingId === latest.id;
  const currentCopyError =
    latest !== undefined && copyError?.id === latest.id ? copyError.message : null;
  const pausedMessage =
    storageStatus.kind === "loading"
      ? "Checking account — adding is paused"
      : storageStatus.kind === "offline" || storageStatus.kind === "failed"
        ? "Offline — cached snippets stay available"
        : "Adding is paused — finish account setup on the web";

  const handleIngestion = (ingestion: ReturnType<typeof ingestFileSnippet>) => {
    setError(null);
    void ingestion.then(
      (result) => {
        if (result.status === "FAILED") setError(result.message);
      },
      () => setError("Plakk couldn’t save this snippet."),
    );
  };

  const upload = (file: Pick<File, "name" | "size" | "type">, sourceId?: string) => {
    if (ingestionProvider === null) return;
    handleIngestion(ingestFileSnippet(ingestionProvider, file, sourceId));
  };

  const addText = (text: string) => {
    if (ingestionProvider === null) return;
    const ingestion = ingestTextSnippet(ingestionProvider, text.trim());
    if (ingestion !== null) handleIngestion(ingestion);
  };

  const addClipboard = async (content: ClipboardContent) => {
    try {
      if (content.type === "text") addText(content.text);
      else if (content.type === "image") {
        const blob = await fetch(content.dataUrl).then((response) => response.blob());
        upload({ name: "Pasted image.png", size: blob.size, type: blob.type }, content.sourceId);
      } else if (content.type === "file" && content.size !== undefined)
        upload({ name: content.name, size: content.size, type: "" }, content.sourceId);
    } catch {
      setError("Plakk couldn’t read the clipboard item.");
    }
  };

  const addDropped = (item: TrayDroppedItem) => {
    if (item.type === "text") addText(item.text);
    else
      for (const file of item.files)
        upload({ name: file.name, size: file.size, type: "" }, file.sourceId);
  };

  useEffect(() => {
    if (!ingestionAllowed) setIsDragging(false);
  }, [ingestionAllowed]);

  useEffect(
    () =>
      window.ipc.tray.onDroppedItem((item) => {
        addDropped(item);
      }),
    [addDropped],
  );

  useEffect(() => window.ipc.clipboard.onPaste(addClipboard), [addClipboard]);

  useEffect(() => {
    if (copiedId === null) return;
    const timer = window.setTimeout(() => setCopiedId(null), 1200);
    return () => window.clearTimeout(timer);
  }, [copiedId]);

  const copyLatest = () => {
    if (latest === undefined || copyDisabled) return;
    const snippetId = latest.id;
    setCopiedId(null);
    setCopyingId(snippetId);
    setCopyError(null);
    void window.ipc.snippets
      .copy(snippetId)
      .then(() => setCopiedId(snippetId))
      .catch(() =>
        setCopyError({
          id: snippetId,
          message: "Could not copy this snippet.",
        }),
      )
      .finally(() => setCopyingId((id) => (id === snippetId ? null : id)));
  };

  const runLatestAction = (
    action: (snippetId: string) => Promise<void>,
    fallbackMessage: string,
  ) => {
    if (latest === undefined) return;
    setError(null);
    void action(latest.id).catch((cause) =>
      setError(ipcActionErrorMessage(cause, fallbackMessage)),
    );
  };

  return (
    <TrayShell>
      <header className="flex shrink-0 items-center justify-between gap-3 border-b px-4 py-2.5">
        <div className="flex min-w-0 items-center gap-1">
          <p className="truncate text-xs font-medium">{auth.user?.email ?? "Plakk"}</p>
          <SyncStatusIndicator status={syncStatus} />
        </div>
        {provider !== null && (
          <span className="flex shrink-0 items-center gap-1.5 text-[11px] text-muted-foreground">
            <StorageProviderIcon provider={provider} className="size-3.5" />
            {storageProviderLabel(provider)}
          </span>
        )}
      </header>
      <div
        className="flex min-h-0 flex-1 flex-col"
        onDragEnter={() => {
          if (ingestionAllowed) setIsDragging(true);
        }}
        onDragOver={(event: DragEvent) => {
          event.preventDefault();
          if (!ingestionAllowed) return;
          setIsDragging(true);
        }}
        onDragLeave={(event) => {
          if (!event.currentTarget.contains(event.relatedTarget as Node | null))
            setIsDragging(false);
        }}
        onDrop={(event) => {
          event.preventDefault();
          setIsDragging(false);
          if (event.dataTransfer.files.length) {
            for (const file of Array.from(event.dataTransfer.files)) upload(file);
          } else {
            const text = event.dataTransfer.getData("text/plain").trim();
            if (text) addText(text);
          }
        }}
      >
        {isDragging ? (
          <section className="pointer-events-none grid min-h-0 flex-1 place-items-center border-2 border-dashed border-primary bg-primary/5 text-center">
            <div className="grid gap-1">
              <p className="text-sm font-medium">Drop to add</p>
              <p className="text-xs text-muted-foreground">Release anywhere in the tray</p>
            </div>
          </section>
        ) : (
          <>
            <TrayRecentItem
              snippet={latest}
              copied={isCopied}
              copying={isCopying}
              copyDisabled={copyDisabled}
              readError={snippetReadError}
              onReload={reloadSnippets}
              {...(currentCopyError === null ? {} : { copyError: currentCopyError })}
              onCopy={copyLatest}
              onDelete={() =>
                runLatestAction(
                  latest?.kind === "LOCAL"
                    ? window.ipc.snippets.discard
                    : window.ipc.snippets.delete,
                  latest?.kind === "LOCAL"
                    ? "Could not dismiss this failed upload."
                    : "Could not delete this snippet.",
                )
              }
              onDownload={() =>
                runLatestAction(window.ipc.snippets.download, "Could not download this snippet.")
              }
              onOpenLink={(url) => {
                setError(null);
                void window.ipc
                  .openExternal(url)
                  .catch(() => setError("Plakk couldn’t open this link."));
              }}
            />
            {!ingestionAllowed &&
              storageStatus.kind !== "loading" &&
              storageStatus.kind !== "offline" &&
              storageStatus.kind !== "failed" && (
                <p
                  className="px-4 pb-2 text-[11px] text-muted-foreground"
                  role="status"
                  aria-live="polite"
                >
                  {pausedMessage}
                </p>
              )}
            {error !== null && (
              <p className="px-4 pb-2 text-[11px] text-destructive" role="alert">
                {error}
              </p>
            )}
            <TrayActions
              copyDisabled={copyDisabled}
              copied={isCopied}
              copying={isCopying}
              ingestionDisabled={!ingestionAllowed}
              onCopy={copyLatest}
              onPaste={() => {
                setError(null);
                void window.ipc.clipboard
                  .read()
                  .then(addClipboard)
                  .catch(() => setError("Could not read the clipboard."));
              }}
              onSelect={() =>
                void window.ipc.tray
                  .selectFiles()
                  .then((files) => {
                    for (const file of files)
                      upload({ name: file.name, size: file.size, type: "" }, file.sourceId);
                  })
                  .catch(() => setError("Could not choose a file."))
              }
            />
          </>
        )}
      </div>
    </TrayShell>
  );
}
