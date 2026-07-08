import { useAtomSet, useAtomValue } from "@effect/atom-react";
import { formatFileSize, isHttpUrl, snippetKindForFileName, type Snippet } from "@plakk/shared";
import type { ApiSnippet } from "@plakk/shared/PlakkApi";
import { useEffect, useMemo } from "react";
import { Atom } from "effect/unstable/reactivity";
import { useUploadActions, useUploadTasks } from "@plakk/ui/hooks/useUploadFlow";
import { plakkApi } from "../api/plakkApi.ts";

const storageProvider = "GOOGLE_DRIVE" as const;

const snippetsAtom = Atom.make<ReadonlyArray<Snippet>>([]).pipe(
  Atom.keepAlive,
  Atom.withLabel("plakk:snippets"),
);

const snippetIssueAtom = Atom.make<string | null>(null).pipe(
  Atom.keepAlive,
  Atom.withLabel("plakk:snippet-issue"),
);

function errorMessage(error: unknown, fallback: string) {
  return typeof error === "object" &&
    error !== null &&
    "message" in error &&
    typeof error.message === "string"
    ? error.message
    : fallback;
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

const upsertSnippet = (
  snippets: ReadonlyArray<Snippet>,
  snippet: Snippet,
): ReadonlyArray<Snippet> =>
  [snippet, ...snippets.filter((item) => item.id !== snippet.id)].slice(0, 20);

export function useSnippetState({ accountBlocked }: { readonly accountBlocked: boolean }) {
  const snippets = useAtomValue(snippetsAtom);
  const setSnippets = useAtomSet(snippetsAtom);
  const issue = useAtomValue(snippetIssueAtom);
  const setIssue = useAtomSet(snippetIssueAtom);
  const uploadActions = useUploadActions();
  const uploadTasks = useUploadTasks();

  useEffect(() => {
    let isCancelled = false;

    plakkApi.listSnippets({ limit: 20 }).then(
      ({ items }) => {
        if (!isCancelled) setSnippets(items.map(apiSnippetToSnippet));
      },
      (error) => {
        if (!isCancelled) setIssue(errorMessage(error, "Could not load snippets."));
      },
    );

    return () => {
      isCancelled = true;
    };
  }, [setIssue, setSnippets]);

  return useMemo(() => {
    const addSnippet = (snippet: Snippet) => {
      if (accountBlocked) return;
      setSnippets((current) => upsertSnippet(current, snippet));
    };

    const addText = (value: string) => {
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

      void plakkApi.createTextSnippet({ id, text: value }).then(
        (snippet) => addSnippet(apiSnippetToSnippet(snippet)),
        (error) => {
          setSnippets((current) => current.filter((snippet) => snippet.id !== id));
          setIssue(errorMessage(error, "Could not add snippet."));
        },
      );
    };

    const startStoredUpload = async (file: File) => {
      const kind = snippetKindForFileName(file.name) === "IMAGE" ? "IMAGE" : "FILE";
      const task = uploadActions.enqueue({
        fileName: file.name,
        byteSize: file.size,
        contentType: file.type || null,
        kind,
        storageProvider,
      });
      let createdSnippet = false;

      try {
        setIssue(null);
        uploadActions.setPhase(task.id, "PREPARING");
        await plakkApi.createStoredSnippet({
          id: task.id,
          kind,
          title: file.name,
          fileName: file.name,
          byteSize: file.size,
          contentType: file.type || null,
          storageObjectId: null,
          storageProvider,
        });
        createdSnippet = true;
        const prepared = await plakkApi.prepareStoredSnippetUpload({
          snippetId: task.id,
          fileName: file.name,
          byteSize: file.size,
          contentType: file.type || null,
          storageProvider,
        });

        uploadActions.setStorageObjectId(task.id, prepared.storageObjectId);
        uploadActions.setPhase(task.id, "UPLOADING");
      } catch (error) {
        const message = errorMessage(error, "Could not prepare upload.");
        uploadActions.setPhase(task.id, "FAILED", message);
        setIssue(message);
        if (!createdSnippet) return;
        await plakkApi
          .updateStoredSnippetUploadStatus({ id: task.id, uploadStatus: "FAILED" })
          .catch(() => undefined);
      }
    };

    const addFiles = (files: FileList) => {
      if (accountBlocked) return;

      for (const file of Array.from(files)) {
        void startStoredUpload(file);
      }
    };

    const addDropped = (dataTransfer: DataTransfer) => {
      if (accountBlocked) return;

      if (dataTransfer.files.length) {
        addFiles(dataTransfer.files);
        return;
      }

      const dropped = dataTransfer.getData("text/plain").trim();
      if (dropped) addText(dropped);
    };

    const deleteSnippet = (id: string) => {
      const deleted = snippets.find((snippet) => snippet.id === id);
      setSnippets((current) => current.filter((snippet) => snippet.id !== id));
      void plakkApi.deleteSnippet({ id }).catch((error) => {
        if (deleted !== undefined) addSnippet(deleted);
        setIssue(errorMessage(error, "Could not delete snippet."));
      });
    };

    const uploadSnippets: ReadonlyArray<Snippet> = uploadTasks.map((task) => ({
      id: task.id,
      title: task.fileName,
      subtitle:
        task.errorMessage ??
        `${task.fileName.split(".").pop()?.toUpperCase() ?? "FILE"} · ${formatFileSize(task.byteSize)}`,
      kind: task.kind,
      time: task.phase === "FAILED" ? "failed" : "",
      synced: task.phase === "READY",
      ...(task.phase === "READY" || task.phase === "FAILED"
        ? {}
        : { uploadProgress: task.progress }),
    }));

    return {
      addDropped,
      addFiles,
      addText,
      deleteSnippet,
      issue,
      setIssue,
      stopUpload: (id: string) => uploadActions.remove(id),
      visibleSnippets: [
        ...uploadSnippets,
        ...snippets.filter((snippet) => !uploadTasks.some((task) => task.id === snippet.id)),
      ].slice(0, 20),
    };
  }, [accountBlocked, issue, setIssue, setSnippets, snippets, uploadActions, uploadTasks]);
}
