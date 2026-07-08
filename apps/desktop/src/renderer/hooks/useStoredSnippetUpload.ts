import { useCallback } from "react";
import { snippetKindForFileName, type StorageProvider } from "@plakk/shared";
import { useUploadActions } from "@plakk/ui/hooks/useUploadFlow";
import { plakkApi } from "../lib/plakkApi.ts";

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function errorMessage(error: unknown, fallback: string) {
  return error instanceof Error ? error.message : fallback;
}

async function markStoredSnippetReady(id: string, storageObjectId: string | null) {
  let lastError: unknown;

  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      return await plakkApi.updateStoredSnippetUploadStatus({
        id,
        uploadStatus: "READY",
        storageObjectId,
      });
    } catch (error) {
      lastError = error;
      if (attempt < 2) await wait(250 * (attempt + 1));
    }
  }

  throw lastError;
}

export function useStoredSnippetUpload(storageProvider: StorageProvider) {
  const uploadActions = useUploadActions();

  return useCallback(
    async (file: File) => {
      const kind = snippetKindForFileName(file.name) === "IMAGE" ? "IMAGE" : "FILE";
      const task = uploadActions.enqueue({
        fileName: file.name,
        byteSize: file.size,
        contentType: file.type || null,
        kind,
        storageProvider,
      });
      let createdSnippet = false;
      let uploadedFile = false;

      try {
        uploadActions.setPhase(task.id, "PREPARING");
        const prepared = await plakkApi.prepareStoredSnippetUpload({
          byteSize: file.size,
          contentType: file.type || null,
          fileName: file.name,
          snippetId: task.id,
          storageProvider,
        });
        uploadActions.setStorageObjectId(task.id, prepared.storageObjectId);
        await plakkApi.createStoredSnippet({
          id: task.id,
          kind,
          title: file.name,
          fileName: file.name,
          byteSize: file.size,
          contentType: file.type || null,
          storageProvider,
          storageObjectId: prepared.storageObjectId,
        });
        createdSnippet = true;
        uploadActions.setPhase(task.id, "UPLOADING");
        await window.ipc.storage.uploadPreparedFile({
          file,
          byteSize: file.size,
          prepared,
        });
        uploadedFile = true;
        const snippet = await markStoredSnippetReady(task.id, prepared.storageObjectId);
        uploadActions.setProgress(task.id, 100);
        uploadActions.remove(task.id);
        return snippet;
      } catch (error) {
        if (createdSnippet && !uploadedFile) {
          await plakkApi
            .updateStoredSnippetUploadStatus({ id: task.id, uploadStatus: "FAILED" })
            .catch(() => undefined);
        }
        const message = errorMessage(error, "Could not upload file.");
        uploadActions.setPhase(task.id, "FAILED", message);
        throw new Error(message);
      }
    },
    [storageProvider, uploadActions],
  );
}
