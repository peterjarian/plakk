import { useEffect, useState, type DragEvent } from "react";
import {
  addDroppedData,
  addTrayDroppedItem,
  advanceUploads,
  canAddSnippets,
  useSnippets,
} from "../lib/snippets.ts";
import { TrayActions } from "./tray/TrayActions.tsx";
import { TrayDropZone } from "./tray/TrayDropZone.tsx";
import { TrayQueue } from "./tray/TrayQueue.tsx";
import { TrayShell } from "./tray/TrayShell.tsx";

export function Tray() {
  const [isDragging, setIsDragging] = useState(false);
  const snippets = useSnippets();
  const hasUploads = snippets.some((snippet) => snippet.uploadProgress !== undefined);

  useEffect(
    () =>
      window.ipc.tray.onDroppedItem((item) => {
        addTrayDroppedItem(item);
      }),
    [],
  );

  useEffect(() => {
    if (!hasUploads) return;

    const timer = window.setInterval(() => {
      advanceUploads();
    }, 160);

    return () => window.clearInterval(timer);
  }, [hasUploads]);

  return (
    <TrayShell>
      <div
        className="flex min-h-0 flex-1 flex-col"
        onDragEnter={() => {
          if (canAddSnippets) setIsDragging(true);
        }}
        onDragOver={(event: DragEvent) => {
          event.preventDefault();
          if (!canAddSnippets) return;
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
        <TrayQueue snippets={snippets.slice(0, 8)} />
        <TrayActions />
      </div>
    </TrayShell>
  );
}
