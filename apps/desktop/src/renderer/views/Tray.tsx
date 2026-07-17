import { useEffect, useState, type DragEvent } from "react";
import { accountCanSync } from "@plakk/shared/PlakkApi";
import type { TrayAccountState } from "../../ipc/contracts.ts";
import { TrayActions } from "./tray/TrayActions.tsx";
import { TrayRecentItem } from "./tray/TrayRecentItem.tsx";
import { TrayShell } from "./tray/TrayShell.tsx";
import { useTraySnippets } from "./tray/useTraySnippets.ts";

export function Tray() {
  const [isDragging, setIsDragging] = useState(false);
  const [isCopied, setIsCopied] = useState(false);
  const [isCopying, setIsCopying] = useState(false);
  const [accountState, setAccountState] = useState<TrayAccountState>({ kind: "loading" });
  const ingestionAllowed = accountState.kind === "resolved" && accountCanSync(accountState.account);
  const account = accountState.kind === "resolved" ? accountState.account : null;
  const { addClipboard, addDropped, addText, latest, upload } = useTraySnippets(account);
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
    void window.ipc.tray.getAccountState().then((state) => {
      if (mounted) setAccountState(state);
    });
    return () => {
      mounted = false;
      unsubscribe();
    };
  }, []);

  useEffect(
    () =>
      window.ipc.tray.onDroppedItem((item) => {
        addDropped(item);
      }),
    [addDropped],
  );

  useEffect(() => window.ipc.clipboard.onPaste(addClipboard), [addClipboard]);

  useEffect(() => {
    if (!isCopied) return;
    const timer = window.setTimeout(() => setIsCopied(false), 1200);
    return () => window.clearTimeout(timer);
  }, [isCopied]);

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
            <TrayRecentItem snippet={latest} />
            {!ingestionAllowed && (
              <p
                className="px-4 pb-2 text-[11px] text-muted-foreground"
                role="status"
                aria-live="polite"
              >
                {pausedMessage}
              </p>
            )}
            <TrayActions
              copyDisabled={latest === undefined || "phase" in latest}
              copied={isCopied}
              copying={isCopying}
              ingestionDisabled={!ingestionAllowed}
              onCopy={() => {
                if (latest === undefined || "phase" in latest) return;
                setIsCopied(false);
                setIsCopying(true);
                void window.ipc.snippets
                  .copy(latest.id)
                  .then(() => setIsCopied(true))
                  .finally(() => setIsCopying(false));
              }}
              onPaste={() => void window.ipc.clipboard.read().then(addClipboard)}
              onSelect={() =>
                void window.ipc.tray.selectFiles().then((files) => {
                  for (const file of files)
                    upload({ name: file.name, size: file.size, type: "" }, file.path);
                })
              }
            />
          </>
        )}
      </div>
    </TrayShell>
  );
}
