import { useEffect, useMemo, useRef, useState } from "react";
import { ArrowUpRight, Plus, TriangleAlert } from "lucide-react";
import { useAtomSet, useAtomValue } from "@effect/atom-react";
import { snippetKindForFileName } from "@plakk/shared";
import type { ApiSnippet } from "@plakk/shared/PlakkApi";
import {
  createTextSnippetOptions,
  deleteSnippetOptions,
  emptySnippetsAtom,
  snippetReactivityKeys,
  type SnippetRequestHeaders,
} from "@plakk/ui/atoms/snippets";
import { createPlakkRpc } from "@plakk/ui/atoms/rpc";
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
import { useActiveUploadTasks, useUploadActions } from "@plakk/ui/hooks/useUploadFlow";
import { AsyncResult } from "effect/unstable/reactivity";
import { SnippetComposer } from "../components/SnippetComposer.tsx";
import { useAuth } from "../hooks/useAuth.ts";
import { navigate } from "../lib/navigate.ts";
import { startUploadProgress } from "../lib/uploadProgress.ts";

const accountSetupUrl = "https://app.plakk.io/account/setup";
const plakkRpc = createPlakkRpc(window.ipc.runtimeConfig.plakkRpcUrl);
const createTextSnippetMutationAtom = plakkRpc.mutation("CreateTextSnippet");
const deleteSnippetMutationAtom = plakkRpc.mutation("DeleteSnippet");

export function Home() {
  const auth = useAuth();
  const [isDragging, setIsDragging] = useState(false);
  const [copiedId, setCopiedId] = useState<string | null>(null);
  const [pendingExternalUrl, setPendingExternalUrl] = useState<string | null>(null);
  const [skipExternalLinkWarning, setSkipExternalLinkWarning] = useState(false);
  const [showExternalLinkWarning, setShowExternalLinkWarning] = useState(true);
  const copiedTimerRef = useRef<number | undefined>(undefined);

  const snippetHeaders = useMemo<SnippetRequestHeaders | null>(
    () => (auth.accessToken === null ? null : { authorization: `Bearer ${auth.accessToken}` }),
    [auth.accessToken],
  );
  const snippetsAtom = useMemo(() => {
    if (snippetHeaders === null) return emptySnippetsAtom;
    return plakkRpc.query(
      "ListSnippets",
      { limit: 20 },
      {
        headers: snippetHeaders,
        reactivityKeys: snippetReactivityKeys,
        serializationKey: "latest",
      },
    );
  }, [snippetHeaders]);
  const snippetsResult = useAtomValue(snippetsAtom);
  const syncedSnippetResponse = AsyncResult.getOrElse(snippetsResult, () => ({
    items: [] as ReadonlyArray<ApiSnippet>,
  }));
  const createTextSnippet = useAtomSet(createTextSnippetMutationAtom, { mode: "promise" });
  const deleteSyncedSnippet = useAtomSet(deleteSnippetMutationAtom, { mode: "promise" });
  const uploadActions = useUploadActions();
  const uploadTasks = useActiveUploadTasks();
  const snippets = [...uploadTasks, ...syncedSnippetResponse.items];
  const accountBlocked = auth.accessToken === null;
  const user = auth.user;
  const hasUploads = uploadTasks.length > 0;

  useEffect(() => {
    if (!hasUploads) return;
    return startUploadProgress(uploadActions);
  }, [hasUploads, uploadActions]);

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
          if (snippetHeaders !== null) {
            void createTextSnippet(createTextSnippetOptions(snippetHeaders, content.text));
          }
          return;
        }

        if (content.type === "image") {
          uploadActions.enqueue({
            byteSize: 0,
            contentType: "image/png",
            fileName: "Pasted image",
            kind: "IMAGE",
            storageProvider: "GOOGLE_DRIVE",
          });
          return;
        }

        if (content.type === "file") {
          const kind = snippetKindForFileName(content.name);
          if (kind !== "FILE" && kind !== "IMAGE") return;

          uploadActions.enqueue({
            byteSize: content.size ?? 0,
            contentType: null,
            fileName: content.name,
            kind,
            storageProvider: "GOOGLE_DRIVE",
          });
        }
      }),
    [accountBlocked, createTextSnippet, snippetHeaders, uploadActions],
  );

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

        if (event.dataTransfer.files.length) {
          for (const file of Array.from(event.dataTransfer.files)) {
            const kind = snippetKindForFileName(file.name);
            if (kind !== "FILE" && kind !== "IMAGE") continue;
            uploadActions.enqueue({
              byteSize: file.size,
              contentType: file.type || null,
              fileName: file.name,
              kind,
              storageProvider: "GOOGLE_DRIVE",
            });
          }
          return;
        }

        const dropped = event.dataTransfer.getData("text/plain").trim();
        if (dropped && snippetHeaders !== null) {
          void createTextSnippet(createTextSnippetOptions(snippetHeaders, dropped));
        }
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
          <SnippetComposer
            disabled={accountBlocked}
            onSubmit={(text) => {
              if (snippetHeaders !== null) {
                void createTextSnippet(createTextSnippetOptions(snippetHeaders, text));
              }
            }}
            onFiles={(files) => {
              if (accountBlocked) return;

              for (const file of Array.from(files)) {
                const kind = snippetKindForFileName(file.name);
                if (kind !== "FILE" && kind !== "IMAGE") continue;
                uploadActions.enqueue({
                  byteSize: file.size,
                  contentType: file.type || null,
                  fileName: file.name,
                  kind,
                  storageProvider: "GOOGLE_DRIVE",
                });
              }
            }}
          />
        </div>

        <SnippetList empty={snippets.length === 0}>
          {snippets.map((snippet) => (
            <SnippetRow
              key={snippet.id}
              snippet={snippet}
              copied={copiedId === snippet.id}
              onCopy={() => {
                void navigator.clipboard?.writeText(
                  "phase" in snippet ? snippet.fileName : snippet.title,
                );
                setCopiedId(snippet.id);
                if (copiedTimerRef.current !== undefined) {
                  window.clearTimeout(copiedTimerRef.current);
                }
                copiedTimerRef.current = window.setTimeout(() => {
                  setCopiedId((copied) => (copied === snippet.id ? null : copied));
                }, 1200);
              }}
              onDelete={() => {
                if ("phase" in snippet) {
                  uploadActions.remove(snippet.id);
                  return;
                }
                if (snippetHeaders !== null) {
                  void deleteSyncedSnippet(deleteSnippetOptions(snippetHeaders, snippet.id));
                }
              }}
              {...(snippet.kind === "LINK" ? { onOpenLink: openLink } : {})}
              onStopUpload={() => uploadActions.remove(snippet.id)}
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
