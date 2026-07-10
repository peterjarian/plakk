import { describe, expect, it, vi } from "vite-plus/test";

import { cancelStoredSnippetUpload, uploadStoredSnippet } from "./storedSnippetUpload.ts";

const task = {
  id: "0d1e2f3a-4567-4890-8abc-def012345678",
  fileName: "upload.txt",
  byteSize: 3,
  contentType: "text/plain",
  kind: "FILE" as const,
  storageProvider: "GOOGLE_DRIVE" as const,
  phase: "QUEUED" as const,
  progress: 0,
  storageObjectId: null,
  errorMessage: null,
};
const file = { name: "upload.txt", size: 3, type: "text/plain" } as File;
const prepared = {
  storageProvider: "GOOGLE_DRIVE" as const,
  storageObjectId: null,
  upload: {
    method: "PUT" as const,
    url: "https://upload.example/drive",
    headers: [],
    strategy: { type: "single_request" as const },
  },
  expiresAt: null,
};
const snippet = {
  id: task.id,
  kind: "FILE" as const,
  title: task.fileName,
  fileName: task.fileName,
  byteSize: task.byteSize,
  contentType: task.contentType,
  storageProvider: task.storageProvider,
  uploadStatus: "READY" as const,
  createdAt: "2026-07-10T00:00:00.000Z",
  updatedAt: "2026-07-10T00:00:00.000Z",
};

function uploadInput() {
  const setPhase = vi.fn();
  const setStorageObjectId = vi.fn();
  const prepare = vi.fn().mockResolvedValue(prepared);
  const create = vi.fn().mockResolvedValue(snippet);
  const updateStatus = vi.fn().mockResolvedValue(snippet);
  const uploadPreparedFile = vi.fn().mockResolvedValue({ storageObjectId: "drive-file-id" });
  return {
    file,
    task,
    actions: { setPhase, setStorageObjectId },
    api: { prepare, create, updateStatus },
    uploader: { uploadPreparedFile },
  };
}

describe("uploadStoredSnippet", () => {
  it("creates text metadata without a body and uploads the already-encoded bytes", async () => {
    const input = uploadInput();
    const bytes = new TextEncoder().encode("héllo 👋\n");
    const textTask = {
      ...task,
      kind: "TEXT" as const,
      fileName: `${task.id}.txt`,
      byteSize: bytes.byteLength,
      contentType: "text/plain; charset=utf-8",
    };
    const textFile = {
      name: textTask.fileName,
      size: bytes.byteLength,
      type: textTask.contentType,
    } as File;

    await uploadStoredSnippet({ ...input, task: textTask, file: textFile, bytes });

    expect(input.api.create).toHaveBeenCalledWith({
      id: textTask.id,
      kind: "TEXT",
      byteSize: bytes.byteLength,
      storageProvider: "GOOGLE_DRIVE",
      storageObjectId: null,
    });
    expect(input.api.prepare).toHaveBeenCalledWith({
      snippetId: textTask.id,
      storageProvider: "GOOGLE_DRIVE",
    });
    expect(input.uploader.uploadPreparedFile).toHaveBeenCalledWith({
      id: textTask.id,
      byteSize: bytes.byteLength,
      prepared,
      bytes,
    });
  });

  it("persists the confirmed Dropbox path when marking the task ready", async () => {
    const input = uploadInput();
    const storageObjectId = "/0d1e2f3a-4567-4890-8abc-def012345678/upload.txt";
    input.api.prepare.mockResolvedValue({
      ...prepared,
      storageProvider: "DROPBOX",
      storageObjectId,
    });
    input.uploader.uploadPreparedFile.mockResolvedValue({ storageObjectId });

    await expect(
      uploadStoredSnippet({ ...input, task: { ...task, storageProvider: "DROPBOX" } }),
    ).resolves.toEqual(snippet);
    expect(input.api.create).toHaveBeenCalledWith(
      expect.objectContaining({ storageObjectId: null }),
    );
    expect(input.api.updateStatus).toHaveBeenCalledWith({
      id: task.id,
      uploadStatus: "READY",
      storageObjectId,
    });
    expect(input.actions.setPhase.mock.calls).toEqual([
      [task.id, "PREPARING"],
      [task.id, "UPLOADING"],
      [task.id, "READY"],
    ]);
    expect(input.actions.setStorageObjectId.mock.calls).toEqual([
      [task.id, storageObjectId],
      [task.id, storageObjectId],
    ]);
  });

  it.each([new Error("Upload failed: 500"), new Error("Upload failed: 410 expired")])(
    "marks provider failures as failed",
    async (error) => {
      const input = uploadInput();
      input.uploader.uploadPreparedFile.mockRejectedValue(error);

      await expect(uploadStoredSnippet(input)).rejects.toThrow(error.message);
      expect(input.api.updateStatus).toHaveBeenCalledWith({
        id: task.id,
        uploadStatus: "FAILED",
        storageObjectId: null,
      });
    },
  );

  it("marks finalization failures as failed instead of false-ready", async () => {
    const input = uploadInput();
    input.api.updateStatus.mockRejectedValueOnce(new Error("Could not finalize"));

    await expect(uploadStoredSnippet(input)).rejects.toThrow("Could not finalize");
    expect(input.api.updateStatus).toHaveBeenNthCalledWith(1, {
      id: task.id,
      uploadStatus: "READY",
      storageObjectId: "drive-file-id",
    });
    expect(input.api.updateStatus).toHaveBeenNthCalledWith(2, {
      id: task.id,
      uploadStatus: "FAILED",
      storageObjectId: "drive-file-id",
    });
  });

  it("marks metadata failed when cancellation happens before preparation", async () => {
    const input = uploadInput();
    const upload = uploadStoredSnippet(input);
    cancelStoredSnippetUpload(task.id);

    await expect(upload).rejects.toThrow("Upload cancelled");
    expect(input.api.create).toHaveBeenCalledOnce();
    expect(input.api.updateStatus).toHaveBeenCalledWith({
      id: task.id,
      uploadStatus: "FAILED",
      storageObjectId: null,
    });
    expect(input.uploader.uploadPreparedFile).not.toHaveBeenCalled();
  });

  it("marks metadata failed when upload preparation fails", async () => {
    const input = uploadInput();
    input.api.prepare.mockRejectedValue(new Error("Storage disconnected"));

    await expect(uploadStoredSnippet(input)).rejects.toThrow("Storage disconnected");
    expect(input.api.updateStatus).toHaveBeenCalledWith({
      id: task.id,
      uploadStatus: "FAILED",
      storageObjectId: null,
    });
    expect(input.uploader.uploadPreparedFile).not.toHaveBeenCalled();
  });

  it("cancels after creation and marks the snippet failed", async () => {
    const input = uploadInput();
    input.uploader.uploadPreparedFile.mockImplementation(async () => {
      cancelStoredSnippetUpload(task.id);
      return { storageObjectId: "drive-file-id" };
    });

    await expect(uploadStoredSnippet(input)).rejects.toThrow("Upload cancelled");
    expect(input.api.create).toHaveBeenCalledTimes(1);
    expect(input.api.updateStatus).toHaveBeenCalledWith({
      id: task.id,
      uploadStatus: "FAILED",
      storageObjectId: null,
    });
  });
});
