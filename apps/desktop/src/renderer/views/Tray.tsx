import { ArrowRight } from "lucide-react";
import { Button } from "@plakk/ui/components/primitives/button";
import { useEffect, useState } from "react";
import { useAuth } from "../hooks/useAuth.ts";
import { TrayActions } from "./tray/TrayActions.tsx";
import { TrayDropZone } from "./tray/TrayDropZone.tsx";
import { TrayQueue, type TrayQueueItem } from "./tray/TrayQueue.tsx";
import { TrayShell } from "./tray/TrayShell.tsx";
import type { TrayDroppedItem } from "../../trayDrop.ts";

export function Tray() {
  const auth = useAuth();
  const [items, setItems] = useState<TrayQueueItem[]>(initialItems);

  useEffect(
    () =>
      window.ipc.tray.onDroppedItem((item) => {
        setItems((current) => [...queueItemsForDrop(item), ...current].slice(0, 8));
      }),
    [],
  );

  if (auth.user === null) {
    return (
      <TrayShell>
        <section className="drag-region flex min-h-0 flex-1 flex-col justify-center gap-4 p-4 text-center">
          <div className="grid gap-1">
            <p className="text-xs font-medium tracking-wide text-muted-foreground uppercase">
              Plakk
            </p>
            <h1 className="text-xl leading-tight font-semibold">Sign in to use the tray.</h1>
            <p className="text-sm text-muted-foreground">
              Drop, capture, and send snippets from here once connected.
            </p>
          </div>

          {auth.issue && <p className="text-xs text-muted-foreground">{auth.issue.message}</p>}

          <Button
            type="button"
            className="h-9 w-full"
            disabled={auth.isLoading}
            onClick={() => void auth.signIn()}
          >
            {auth.isLoading ? "Checking session..." : "Sign in"}
            <ArrowRight />
          </Button>
        </section>
      </TrayShell>
    );
  }

  return (
    <TrayShell>
      <TrayDropZone />
      <TrayQueue items={items} />
      <TrayActions />
    </TrayShell>
  );
}

const initialItems: TrayQueueItem[] = [
  {
    kind: "link",
    title: "https://plakk.io/pricing",
    detail: "Link - just now",
  },
  {
    kind: "image",
    title: "Screenshot 14.32.10.png",
    detail: "Image - 1.8 MB",
  },
  {
    kind: "text",
    title: "Meeting notes from desktop",
    detail: "Text - 214 chars",
  },
  {
    kind: "file",
    title: "Invoice-june.pdf",
    detail: "File - synced",
  },
];

function queueItemsForDrop(item: TrayDroppedItem): TrayQueueItem[] {
  if (item.type === "text") {
    const text = item.text.trim();
    return [{ kind: "text", title: text, detail: `Text - ${text.length} chars` }];
  }

  return item.paths.map((path) => {
    const title = path.split(/[\\/]/).pop() || path;
    return {
      kind: kindForName(title),
      title,
      detail: "Dropped just now",
    };
  });
}

function kindForName(name: string): TrayQueueItem["kind"] {
  return /\.(avif|bmp|gif|heic|jpe?g|png|svg|tiff?|webp)$/i.test(name) ? "image" : "file";
}
