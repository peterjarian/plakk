import { useEffect, useState, type DragEvent } from "react";
import { accountCanSync } from "@plakk/shared/PlakkApi";
import type { TrayAccountState } from "../../ipc/contracts.ts";
import { TrayActions } from "./tray/TrayActions.tsx";
import { TrayRecentItem } from "./tray/TrayRecentItem.tsx";
import { TrayShell } from "./tray/TrayShell.tsx";
import { useTraySnippets } from "./tray/useTraySnippets.ts";

export function Tray() {
  const [isDragging, setIsDragging] = useState(false);
  const [copiedId, setCopiedId] = useState<string | null>(null);
  const [copyingId, setCopyingId] = useState<string | null>(null);
  const [copyError, setCopyError] = useState<{ id: string; message: string } | null>(null);
  const [accountState, setAccountState] = useState<TrayAccountState>({ kind: "loading" });
  const ingestionAllowed = accountState.kind === "resolved" && accountCanSync(accountState.account);
  const account = accountState.kind === "resolved" ? accountState.account : null;
  const {
    addClipboard,
    addDropped,
    addText,
    error,
    latest,
    reloadSnippets,
    reportError,
    snippetReadError,
    upload,
  } = useTraySnippets(account);
  const copyDisabled =
    latest === undefined || (!latest.contentAvailable && latest.uploadStatus !== "UPLOADED");
  const isCopied = latest !== undefined && copiedId === latest.id;
  const isCopying = latest !== undefined && copyingId === latest.id;
  const currentCopyError =
    latest !== undefined && copyError?.id === latest.id ? copyError.message : null;
  const pausedMessage =
    accountState.kind === "loading"
      ? "Checking account — adding is paused"
      : accountState.kind === "failed"
        ? "Offline — cached snippets stay available"
        : "Adding is paused — finish account setup on the web";

  useEffect(() => {
    if (!ingestionAllowed) setIsDragging(false);
  }, [ingestionAllowed]);

  useEffect(() => {
    let mounted = true;
    const unsubscribe = window.ipc.tray.onAccountStateChanged(setAccountState);
    void window.ipc.tray.getAccountState().then(
      (state) => {
        if (mounted) setAccountState(state);
      },
      () => {
        if (mounted) {
          setAccountState({ kind: "failed" });
          reportError("Could not check the account.");
        }
      },
    );
    return () => {
      mounted = false;
      unsubscribe();
    };
  }, [reportError]);

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
    reportError(null);
    void action(latest.id).catch(() => reportError(fallbackMessage));
  };

  return (
    <TrayShell>
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
                runLatestAction(window.ipc.snippets.delete, "Could not delete this snippet.")
              }
              onRetryUpload={() =>
                runLatestAction(window.ipc.snippets.retry, "Could not retry this upload.")
              }
              onStopUpload={() =>
                runLatestAction(window.ipc.snippets.cancel, "Could not stop this upload.")
              }
            />
            {!ingestionAllowed && (
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
                reportError(null);
                void window.ipc.clipboard
                  .read()
                  .then(addClipboard)
                  .catch(() => reportError("Could not read the clipboard."));
              }}
              onSelect={() =>
                void window.ipc.tray
                  .selectFiles()
                  .then((files) => {
                    for (const file of files)
                      upload({ name: file.name, size: file.size, type: "" }, file.path);
                  })
                  .catch(() => reportError("Could not choose a file."))
              }
            />
          </>
        )}
      </div>
    </TrayShell>
  );
}
