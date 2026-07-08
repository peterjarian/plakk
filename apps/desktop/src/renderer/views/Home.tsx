import { useEffect, useRef, useState } from "react";
import { ArrowUpRight, Plus, TriangleAlert } from "lucide-react";
import { formatFileSize, isHttpUrl, snippetKindForFileName, type Snippet } from "@plakk/shared";
import type { ApiSnippet } from "@plakk/shared/PlakkApi";
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
import { useUploadActions, useUploadTasks } from "@plakk/ui/hooks/useUploadFlow";
import { SnippetComposer } from "../components/SnippetComposer.tsx";
import { useAuth } from "../hooks/useAuth.ts";
import { navigate } from "../lib/navigate.ts";

const accountSetupUrl = "https://app.plakk.io/account/setup";
const storageProvider = "GOOGLE_DRIVE" as const;

function errorMessage(error: unknown, fallback: string) {
  return error instanceof Error ? error.message : fallback;
}

function apiSnippetToSnippet(snippet: ApiSnippet): Snippet {
  const kind: Snippet["kind"] =
    snippet.kind === "TEXT" && isHttpUrl(snippet.title) ? "LINK" : snippet.kind;
  return {
    id: snippet.id,
    title: snippet.title,
    subtitle:
      snippet.kind === "TEXT"
        ? isHttpUrl(snippet.title)
          ? ""
          : formatFileSize(snippet.byteSize)
        : `${snippet.fileName.split(".").pop()?.toUpperCase() ?? "FILE"} · ${formatFileSize(snippet.byteSize)}`,
    kind,
    time: "now",
    synced: snippet.uploadStatus === "READY",
    ...(snippet.uploadStatus === "UPLOADING" ? { uploadProgress: 0 } : {}),
  };
}

export function Home() {
  const auth = useAuth();
  const uploadActions = useUploadActions();
  const uploadTasks = useUploadTasks();
  const [isDragging, setIsDragging] = useState(false);
  const [copiedId, setCopiedId] = useState<string | null>(null);
  const [accountIssue, setAccountIssue] = useState<string | null>(null);
  const [pendingExternalUrl, setPendingExternalUrl] = useState<string | null>(null);
  const [skipExternalLinkWarning, setSkipExternalLinkWarning] = useState(false);
  const [snippets, setSnippets] = useState<Array<Snippet>>([]);
  const [showExternalLinkWarning, setShowExternalLinkWarning] = useState(true);
  const copiedTimerRef = useRef<number | undefined>(undefined);

  const accountBlocked = false;
  const user = auth.user;
  const uploadSnippets: Array<Snippet> = uploadTasks.map((task) => ({
    id: task.id,
    title: task.fileName,
    subtitle:
      task.errorMessage ??
      `${task.fileName.split(".").pop()?.toUpperCase() ?? "FILE"} · ${formatFileSize(task.byteSize)}`,
    kind: task.kind,
    time: task.phase === "FAILED" ? "failed" : "",
    synced: task.phase === "READY",
    ...(task.phase === "READY" || task.phase === "FAILED" ? {} : { uploadProgress: task.progress }),
  }));
  const visibleSnippets = [
    ...uploadSnippets,
    ...snippets.filter((snippet) => !uploadTasks.some((task) => task.id === snippet.id)),
  ].slice(0, 20);

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
    let isCancelled = false;

    window.ipc.plakkApi.listSnippets({ limit: 20 }).then(
      ({ items }) => {
        if (!isCancelled) setSnippets(items.map(apiSnippetToSnippet));
      },
      (error) => {
        if (!isCancelled) setAccountIssue(errorMessage(error, "Could not load snippets."));
      },
    );

    return () => {
      isCancelled = true;
    };
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
          setAccountIssue("Pasted images need file upload support. Drag the file in for now.");
          return;
        }

        if (content.type === "file") {
          setAccountIssue("Clipboard file metadata is not enough to upload yet. Drag the file in.");
        }
      }),
    [accountBlocked],
  );

  function addSnippet(snippet: Snippet) {
    if (accountBlocked) return;

    setSnippets((current) =>
      [snippet, ...current.filter((item) => item.id !== snippet.id)].slice(0, 20),
    );
  }

  function addText(value: string) {
    if (accountBlocked) return;

    const id = crypto.randomUUID();
    addSnippet({
      id,
      title: value,
      subtitle: isHttpUrl(value) ? "" : `${value.length} characters`,
      kind: isHttpUrl(value) ? "LINK" : "TEXT",
      time: "now",
      synced: false,
    });

    void window.ipc.plakkApi.createTextSnippet({ id, text: value }).then(
      (snippet) => {
        addSnippet(apiSnippetToSnippet(snippet));
      },
      (error) => {
        setSnippets((current) => current.filter((snippet) => snippet.id !== id));
        setAccountIssue(errorMessage(error, "Could not add snippet."));
      },
    );
  }

  function addFiles(files: FileList) {
    if (accountBlocked) return;

    for (const file of Array.from(files)) {
      void startStoredUpload(file);
    }
  }

  async function startStoredUpload(file: File) {
    const kind = snippetKindForFileName(file.name) === "IMAGE" ? "IMAGE" : "FILE";
    const task = uploadActions.enqueue({
      fileName: file.name,
      byteSize: file.size,
      contentType: file.type || null,
      kind,
      storageProvider,
    });

    try {
      setAccountIssue(null);
      uploadActions.setPhase(task.id, "UPLOADING");
      const snippet = await window.ipc.storage.uploadStoredSnippetFile({
        file,
        id: task.id,
        kind,
        title: file.name,
        fileName: file.name,
        byteSize: file.size,
        contentType: file.type || null,
        storageProvider,
      });
      uploadActions.setProgress(task.id, 100);
      uploadActions.remove(task.id);
      addSnippet(apiSnippetToSnippet(snippet));
    } catch (error) {
      const message = errorMessage(error, "Could not upload file.");
      uploadActions.setPhase(task.id, "FAILED", message);
      setAccountIssue(message);
    }
  }

  function addDropped(dataTransfer: DataTransfer) {
    if (accountBlocked) return;

    if (dataTransfer.files.length) {
      addFiles(dataTransfer.files);
      return;
    }

    const dropped = dataTransfer.getData("text/plain").trim();
    if (!dropped) return;
    addText(dropped);
  }

  function stopUpload(id: string) {
    uploadActions.remove(id);
  }

  function deleteSnippet(id: string) {
    const deleted = snippets.find((snippet) => snippet.id === id);
    setSnippets((current) => current.filter((snippet) => snippet.id !== id));
    void window.ipc.plakkApi.deleteSnippet({ id }).catch((error) => {
      if (deleted !== undefined) addSnippet(deleted);
      setAccountIssue(errorMessage(error, "Could not delete snippet."));
    });
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
          {(accountBlocked || accountIssue !== null) && (
            <div className="mb-2 flex items-center gap-2 rounded-md bg-muted px-2.5 py-1.5 text-xs text-muted-foreground">
              <TriangleAlert className="size-3.5 shrink-0 text-amber-600" aria-hidden="true" />
              <span className="min-w-0 flex-1 truncate">
                {accountIssue ?? "Sync paused. Finish billing and setup storage to add snippets."}
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

        <SnippetList empty={visibleSnippets.length === 0}>
          {visibleSnippets.map((snippet) => (
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
