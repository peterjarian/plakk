import type { ApiSnippet, PreparedStorageUpload } from "@plakk/shared/PlakkApi";
import type { StorageProvider } from "@plakk/shared";
import type { UploadTask } from "@plakk/ui/atoms/upload";
import type {
  RendererPreparedFileUploadPayload,
  StorageUploadResult,
} from "../../storageUpload.ts";

export type StoredSnippetUploadApi = {
  readonly prepare: (input: {
    snippetId: string;
    storageProvider: StorageProvider;
    fileName: string;
    byteSize: number;
    contentType: string | null;
  }) => Promise<PreparedStorageUpload>;
  readonly create: (input: {
    id: string;
    kind: "FILE" | "IMAGE";
    title: string;
    fileName: string;
    byteSize: number;
    contentType: string | null;
    storageProvider: StorageProvider;
    storageObjectId: string | null;
  }) => Promise<ApiSnippet>;
  readonly updateStatus: (input: {
    id: string;
    uploadStatus: "READY" | "FAILED";
    storageObjectId: string | null;
  }) => Promise<ApiSnippet>;
};

export type StoredSnippetUploadActions = {
  readonly setPhase: (id: string, phase: UploadTask["phase"], errorMessage?: string | null) => void;
  readonly setStorageObjectId: (id: string, storageObjectId: string | null) => void;
};

export type StoredSnippetUploader = {
  readonly uploadPreparedFile: (
    payload: RendererPreparedFileUploadPayload,
  ) => Promise<StorageUploadResult>;
};

const cancelledUploadIds = new Set<string>();

export const cancelStoredSnippetUpload = (id: string) => cancelledUploadIds.add(id);

const throwIfCancelled = (id: string) => {
  if (cancelledUploadIds.has(id)) {
    throw new Error("Upload cancelled. Choose the file again to retry.");
  }
};

async function markUploadFailed(
  api: StoredSnippetUploadApi,
  id: string,
  storageObjectId: string | null,
) {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      await api.updateStatus({ id, uploadStatus: "FAILED", storageObjectId });
      return;
    } catch {
      // The next attempt can recover a transient finalization failure.
    }
  }
}

export async function uploadStoredSnippet(input: {
  readonly file: File;
  readonly task: UploadTask;
  readonly api: StoredSnippetUploadApi;
  readonly actions: StoredSnippetUploadActions;
  readonly uploader: StoredSnippetUploader;
}): Promise<ApiSnippet> {
  const { file, task, api, actions, uploader } = input;
  let created = false;
  let storageObjectId: string | null = null;

  try {
    actions.setPhase(task.id, "PREPARING");
    const prepared = await api.prepare({
      snippetId: task.id,
      storageProvider: task.storageProvider,
      fileName: file.name,
      byteSize: file.size,
      contentType: file.type || null,
    });
    throwIfCancelled(task.id);
    storageObjectId = prepared.storageObjectId;
    actions.setStorageObjectId(task.id, storageObjectId);
    await api.create({
      id: task.id,
      kind: task.kind,
      title: file.name,
      fileName: file.name,
      byteSize: file.size,
      contentType: file.type || null,
      storageProvider: task.storageProvider,
      storageObjectId,
    });
    created = true;
    throwIfCancelled(task.id);
    actions.setPhase(task.id, "UPLOADING");
    const upload = await uploader.uploadPreparedFile({
      id: task.id,
      file,
      byteSize: file.size,
      prepared,
    });
    throwIfCancelled(task.id);
    storageObjectId = upload.storageObjectId;
    actions.setStorageObjectId(task.id, storageObjectId);
    const snippet = await api.updateStatus({
      id: task.id,
      uploadStatus: "READY",
      storageObjectId,
    });
    actions.setPhase(task.id, "READY");
    return snippet;
  } catch (error) {
    if (created) {
      await markUploadFailed(api, task.id, storageObjectId);
    }
    const message = error instanceof Error ? error.message : "Could not upload file. Try again.";
    actions.setPhase(task.id, "FAILED", message);
    throw new Error(message);
  } finally {
    cancelledUploadIds.delete(task.id);
  }
}
