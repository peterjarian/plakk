import { useEffect, useState, type DragEvent } from "react";
import { accountCanSync } from "@plakk/shared/PlakkApi";
import type { TrayAccountState } from "../../ipc/contracts.ts";
import { TrayActions } from "./tray/TrayActions.tsx";
import { TrayRecentItem } from "./tray/TrayRecentItem.tsx";
import { TrayShell } from "./tray/TrayShell.tsx";
import { TrayBlocked } from "./tray/TrayBlocked.tsx";
import { useTraySnippets } from "./tray/useTraySnippets.ts";
import { decodeTextSnippet } from "../lib/textSnippetContent.ts";

export function Tray() {
  const [isDragging, setIsDragging] = useState(false);
  const [isCopied, setIsCopied] = useState(false);
  const [isCopying, setIsCopying] = useState(false);
  const [accountState, setAccountState] = useState<TrayAccountState>({ kind: "loading" });
  const ingestionAllowed = accountState.kind === "resolved" && accountCanSync(accountState.account);
  const account = accountState.kind === "resolved" ? accountState.account : null;
  const { addClipboard, addDropped, addText, latest, upload } = useTraySnippets(account);

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
      {!ingestionAllowed ? (
        <TrayBlocked state={accountState} />
      ) : (
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
              <TrayActions
                copyDisabled={latest === undefined || "phase" in latest}
                copied={isCopied}
                copying={isCopying}
                onCopy={() => {
                  if (latest === undefined || "phase" in latest) return;
                  setIsCopied(false);
                  setIsCopying(true);
                  void (
                    latest.kind === "FILE" || latest.kind === "IMAGE"
                      ? window.ipc.snippets.copy(latest.id)
                      : latest.kind === "LINK"
                        ? navigator.clipboard.writeText(latest.title)
                        : latest.textContent !== null
                          ? navigator.clipboard.writeText(latest.textContent)
                          : latest.contentUrl !== null
                            ? fetch(latest.contentUrl)
                                .then((response) => response.arrayBuffer())
                                .then((bytes) =>
                                  navigator.clipboard.writeText(
                                    decodeTextSnippet(new Uint8Array(bytes)),
                                  ),
                                )
                            : Promise.resolve()
                  )
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
      )}
    </TrayShell>
  );
}
