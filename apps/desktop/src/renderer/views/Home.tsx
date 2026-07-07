import { useEffect, useRef, useState } from "react";
import { ArrowUpRight, Plus, TriangleAlert } from "lucide-react";
import type { Snippet } from "@plakk/shared";
import { AppHeader } from "@plakk/ui/components/AppHeader";
import { SnippetList } from "@plakk/ui/components/SnippetList";
import { SnippetRow } from "@plakk/ui/components/SnippetRow";
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
import {
  addClipboardContent,
  addDroppedData,
  addFiles,
  addTextSnippet,
  advanceUploads,
  deleteSnippet,
  useSnippets,
} from "../lib/snippets.ts";
import { navigate } from "../lib/navigate.ts";

export function Home() {
  const auth = useAuth();
  const [isDragging, setIsDragging] = useState(false);
  const [copiedId, setCopiedId] = useState<string | null>(null);
  const [pendingExternalUrl, setPendingExternalUrl] = useState<string | null>(null);
  const [skipExternalLinkWarning, setSkipExternalLinkWarning] = useState(false);
  const snippets = useSnippets();
  const [showExternalLinkWarning, setShowExternalLinkWarning] = useState(true);
  const copiedTimerRef = useRef<number | undefined>(undefined);

  const user = auth.user;
  const hasUploads = snippets.some((snippet) => snippet.uploadProgress !== undefined);

  useEffect(() => {
    if (!hasUploads) return;

    const timer = window.setInterval(() => {
      advanceUploads();
    }, 160);

    return () => window.clearInterval(timer);
  }, [hasUploads]);

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

  useEffect(
    () =>
      window.ipc.clipboard.onPaste((content) => {
        addClipboardContent(content);
      }),
    [],
  );

  function addText(value: string) {
    addTextSnippet(value);
  }

  function addHomeFiles(files: FileList) {
    addFiles(files);
  }

  function stopUpload(id: string) {
    deleteSnippet(id);
  }

  function copy(snippet: Snippet) {
    void navigator.clipboard?.writeText(snippet.subtitle || snippet.title);
    setCopiedId(snippet.id);
    if (copiedTimerRef.current !== undefined) window.clearTimeout(copiedTimerRef.current);
    copiedTimerRef.current = window.setTimeout(() => {
      setCopiedId((copied) => (copied === snippet.id ? null : copied));
    }, 1200);
  }

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

  if (user === null) return null;

  return (
    <main
      className="flex h-screen flex-col overflow-hidden bg-background text-foreground"
      aria-label="Plakk"
      onDragEnter={() => {
        setIsDragging(true);
      }}
      onDragOver={(event) => {
        event.preventDefault();
        setIsDragging(true);
      }}
      onDragLeave={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setIsDragging(false);
      }}
      onDrop={(event) => {
        event.preventDefault();
        setIsDragging(false);
        addDroppedData(event.dataTransfer);
      }}
    >
      <div className="drag-region h-12" aria-hidden="true" />

      <AppHeader
        user={user}
        onSettingsClick={() => navigate("settings")}
        onSignOutClick={() => void auth.signOut().then(() => navigate("welcome"))}
        storageAction={
          <Button
            type="button"
            variant="ghost"
            size="sm"
            aria-label="Open storage in browser"
            toolTip="Open storage"
            onClick={() => window.ipc.openExternal("https://app.plakk.io/storage")}
          >
            Google Drive
            <ArrowUpRight className="text-muted-foreground" />
          </Button>
        }
      />

      <div className="scrollbar-hidden min-h-0 flex-1 overflow-y-auto px-6 pb-4">
        <div className="sticky top-0 z-20 bg-background pt-3 pb-5">
          <SnippetComposer onSubmit={addText} onFiles={addHomeFiles} />
        </div>

        <SnippetList empty={snippets.length === 0}>
          {snippets.map((snippet) => (
            <SnippetRow
              key={snippet.id}
              snippet={snippet}
              copied={copiedId === snippet.id}
              onCopy={() => copy(snippet)}
              onDelete={() => deleteSnippet(snippet.id)}
              {...(snippet.kind === "LINK" ? { onOpenLink: openLink } : {})}
              onStopUpload={() => stopUpload(snippet.id)}
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
