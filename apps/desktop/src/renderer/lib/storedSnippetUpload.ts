import type {
  ApiSnippet,
  CreateStoredSnippetPayload,
  PreparedStorageUpload,
} from "@plakk/shared/PlakkApi";
import type { UploadTask } from "@plakk/ui/atoms/upload";
import type {
  RendererPreparedFileUploadPayload,
  StorageUploadResult,
} from "../../storageUpload.ts";

export type StoredSnippetUploadApi = {
  readonly prepare: (input: {
    snippetId: string;
    mediaType: string | null;
  }) => Promise<PreparedStorageUpload>;
  readonly create: (input: CreateStoredSnippetPayload) => Promise<ApiSnippet>;
  readonly fail: (input: { id: string }) => Promise<ApiSnippet>;
  readonly complete: (input: { id: string; storageObjectId: string }) => Promise<ApiSnippet>;
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

async function markUploadFailed(api: StoredSnippetUploadApi, id: string) {
  let failure: unknown;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      await api.fail({ id });
      return;
    } catch (error) {
      failure = error;
      // The next attempt can recover a transient finalization failure.
    }
  }
  console.error("Could not mark stored snippet upload as failed.", {
    id,
    failure,
  });
}

export async function uploadStoredSnippet(input: {
  readonly file: Pick<File, "name" | "size" | "type">;
  readonly filePath?: string;
  readonly bytes?: Uint8Array;
  readonly task: UploadTask;
  readonly api: StoredSnippetUploadApi;
  readonly actions: StoredSnippetUploadActions;
  readonly uploader: StoredSnippetUploader;
}): Promise<ApiSnippet> {
  const { file, filePath, bytes, task, api, actions, uploader } = input;
  let created = false;
  let storageObjectId: string | null = null;

  try {
    actions.setPhase(task.id, "PREPARING");
    await api.create({
      id: task.id,
      fileName: file.name,
      byteSize: file.size,
      storageProvider: task.storageProvider,
    });
    created = true;
    throwIfCancelled(task.id);
    const prepared = await api.prepare({
      snippetId: task.id,
      mediaType: file.type || null,
    });
    throwIfCancelled(task.id);
    storageObjectId = prepared.storageObjectId;
    actions.setStorageObjectId(task.id, storageObjectId);
    actions.setPhase(task.id, "UPLOADING");
    const upload = await uploader.uploadPreparedFile({
      id: task.id,
      byteSize: file.size,
      prepared,
      ...(bytes !== undefined
        ? { bytes }
        : filePath === undefined
          ? { file: file as File }
          : { filePath }),
    });
    throwIfCancelled(task.id);
    storageObjectId = upload.storageObjectId;
    actions.setStorageObjectId(task.id, storageObjectId);
    const snippet = await api.complete({
      id: task.id,
      storageObjectId,
    });
    actions.setPhase(task.id, "UPLOADED");
    return snippet;
  } catch (error) {
    if (created) {
      await markUploadFailed(api, task.id);
    }
    const message = error instanceof Error ? error.message : "Could not upload file. Try again.";
    actions.setPhase(task.id, "FAILED", message);
    throw new Error(message);
  } finally {
    cancelledUploadIds.delete(task.id);
  }
}
