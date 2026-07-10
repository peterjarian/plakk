import { useEffect, useState, type DragEvent } from "react";
import { accountCanSync } from "@plakk/shared/PlakkApi";
import type { TrayAccountState } from "../../ipc/contracts.ts";
import {
  addClipboardContent,
  addDroppedData,
  addTrayDroppedItem,
  advanceUploads,
  canAddSnippets,
  setSnippetIngestionEnabled,
  useSnippets,
} from "../lib/snippets.ts";
import { TrayActions } from "./tray/TrayActions.tsx";
import { TrayDropZone } from "./tray/TrayDropZone.tsx";
import { TrayQueue } from "./tray/TrayQueue.tsx";
import { TrayShell } from "./tray/TrayShell.tsx";
import { TrayBlocked } from "./tray/TrayBlocked.tsx";

export function Tray() {
  const [isDragging, setIsDragging] = useState(false);
  const [accountState, setAccountState] = useState<TrayAccountState>({ kind: "loading" });
  const ingestionAllowed = accountState.kind === "resolved" && accountCanSync(accountState.account);
  const snippets = useSnippets();
  const hasUploads = snippets.some((snippet) => snippet.uploadProgress !== undefined);

  useEffect(() => {
    setSnippetIngestionEnabled(ingestionAllowed);
    if (!ingestionAllowed) setIsDragging(false);
    return () => setSnippetIngestionEnabled(false);
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
        addTrayDroppedItem(item);
      }),
    [],
  );

  useEffect(() => window.ipc.clipboard.onPaste(addClipboardContent), []);

  useEffect(() => {
    if (!hasUploads || !ingestionAllowed) return;

    const timer = window.setInterval(() => {
      advanceUploads();
    }, 160);

    return () => window.clearInterval(timer);
  }, [hasUploads, ingestionAllowed]);

  return (
    <TrayShell>
      {!ingestionAllowed ? (
        <TrayBlocked state={accountState} />
      ) : (
        <div
          className="flex min-h-0 flex-1 flex-col"
          onDragEnter={() => {
            if (canAddSnippets()) setIsDragging(true);
          }}
          onDragOver={(event: DragEvent) => {
            event.preventDefault();
            if (!canAddSnippets()) return;
            setIsDragging(true);
          }}
          onDragLeave={(event) => {
            if (!event.currentTarget.contains(event.relatedTarget as Node | null))
              setIsDragging(false);
          }}
          onDrop={(event) => {
            event.preventDefault();
            setIsDragging(false);
            addDroppedData(event.dataTransfer);
          }}
        >
          <TrayDropZone isDragging={isDragging} />
          <TrayQueue snippets={snippets.slice(0, 8)} totalCount={snippets.length} />
          <TrayActions />
        </div>
      )}
    </TrayShell>
  );
}
