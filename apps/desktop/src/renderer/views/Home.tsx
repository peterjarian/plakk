import { useEffect, useRef, useState } from "react";
import { ArrowUpRight, Plus, TriangleAlert } from "lucide-react";
import { formatFileSize, isHttpUrl, snippetKindForFileName, type Snippet } from "@plakk/shared";
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
import { initialSnippets } from "../data/initialSnippets.ts";
import { useAuth } from "../hooks/useAuth.ts";
import { navigate } from "../lib/navigate.ts";

const accountSetupUrl = "https://app.plakk.io/account/setup";

export function Home() {
  const auth = useAuth();
  const [isDragging, setIsDragging] = useState(false);
  const [copiedId, setCopiedId] = useState<string | null>(null);
  const [pendingExternalUrl, setPendingExternalUrl] = useState<string | null>(null);
  const [skipExternalLinkWarning, setSkipExternalLinkWarning] = useState(false);
  const [snippets, setSnippets] = useState(initialSnippets);
  const [showExternalLinkWarning, setShowExternalLinkWarning] = useState(true);
  const copiedTimerRef = useRef<number | undefined>(undefined);

  const accountBlocked = true;
  const user = auth.user;
  const hasUploads = snippets.some((snippet) => snippet.uploadProgress !== undefined);

  useEffect(() => {
    if (!hasUploads) return;

    const timer = window.setInterval(() => {
      setSnippets((current) =>
        current.map((snippet) => {
          if (snippet.uploadProgress === undefined) return snippet;

          const uploadProgress = Math.min(100, snippet.uploadProgress + 8);
          if (uploadProgress < 100) return { ...snippet, uploadProgress };

          const { uploadProgress: _uploadProgress, ...done } = snippet;
          return { ...done, synced: true, time: "now" };
        }),
      );
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
        if (accountBlocked) return;

        if (content.type === "text") {
          addText(content.text);
          return;
        }

        if (content.type === "image") {
          addSnippet({
            title: "Pasted image",
            subtitle: `${content.width} x ${content.height}`,
            kind: "IMAGE",
          });
          return;
        }

        if (content.type === "file") {
          addSnippet({
            title: content.name,
            subtitle:
              content.size === undefined
                ? content.extension || "FILE"
                : `${content.extension || "FILE"} · ${formatFileSize(content.size)}`,
            kind: snippetKindForFileName(content.name),
          });
        }
      }),
    [accountBlocked],
  );

  function addSnippet(snippet: Omit<Snippet, "id" | "time" | "synced">) {
    if (accountBlocked) return;

    setSnippets((current) =>
      [{ ...snippet, id: crypto.randomUUID(), time: "now", synced: true }, ...current].slice(0, 20),
    );
  }

  function addText(value: string) {
    addSnippet(
      isHttpUrl(value)
        ? { title: value, subtitle: "", kind: "LINK" }
        : { title: value, subtitle: `${value.length} characters`, kind: "TEXT" },
    );
  }

  function addFiles(files: FileList) {
    if (accountBlocked) return;

    const uploads = Array.from(files).map((file) => {
      const kind = snippetKindForFileName(file.name);
      return {
        id: crypto.randomUUID(),
        title: file.name,
        subtitle: `${file.name.split(".").pop()?.toUpperCase() ?? "FILE"} · ${formatFileSize(file.size)}`,
        kind,
        time: "",
        synced: false,
        uploadProgress: 0,
      };
    });

    setSnippets((current) => [...uploads, ...current].slice(0, 20));
  }

  function addDropped(dataTransfer: DataTransfer) {
    if (accountBlocked) return;

    if (dataTransfer.files.length) {
      addFiles(dataTransfer.files);
      return;
    }

    const dropped = dataTransfer.getData("text/plain").trim();
    if (!dropped) return;
    if (isHttpUrl(dropped)) {
      addSnippet({ title: dropped, subtitle: "", kind: "LINK" });
    } else {
      addSnippet({ title: dropped, subtitle: `${dropped.length} characters`, kind: "TEXT" });
    }
  }

  function stopUpload(id: string) {
    setSnippets((current) => current.filter((snippet) => snippet.id !== id));
  }

  function deleteSnippet(id: string) {
    setSnippets((current) => current.filter((snippet) => snippet.id !== id));
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
        addDropped(event.dataTransfer);
      }}
    >
      <div className="drag-region h-12" aria-hidden="true" />

      <AppHeader
        user={user}
        onSettingsClick={() => navigate("settings")}
        onSignOutClick={() => void auth.signOut().then(() => navigate("welcome"))}
        storageAction={
          accountBlocked ? null : (
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
          )
        }
      />

      <div className="scrollbar-hidden min-h-0 flex-1 overflow-y-auto px-6 pb-4">
        <div className="sticky top-0 z-20 bg-background pt-3 pb-5">
          {accountBlocked && (
            <div className="mb-2 flex items-center gap-2 rounded-md bg-muted px-2.5 py-1.5 text-xs text-muted-foreground">
              <TriangleAlert className="size-3.5 shrink-0 text-amber-600" aria-hidden="true" />
              <span className="min-w-0 flex-1 truncate">
                Sync paused. Finish billing and setup storage to add snippets.
              </span>
              <Button
                type="button"
                variant="ghost"
                size="xs"
                onClick={() => window.ipc.openExternal(accountSetupUrl)}
              >
                Finish on web
                <ArrowUpRight />
              </Button>
            </div>
          )}
          <SnippetComposer disabled={accountBlocked} onSubmit={addText} onFiles={addFiles} />
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
