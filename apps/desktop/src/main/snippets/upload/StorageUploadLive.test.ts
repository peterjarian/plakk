import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NodeFileSystem } from "@effect/platform-node";
import { Effect, Fiber } from "effect";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

import type { PreparedFileUploadPayload } from "./StorageUpload.ts";
import { uploadPreparedFile } from "./StorageUploadLive.ts";

const fetchMock = vi.fn<typeof fetch>();

async function uploadFile(bytes: ArrayLike<number>) {
  const directory = await mkdtemp(join(tmpdir(), "plakk-upload-"));
  const filePath = join(directory, "upload.bin");
  await writeFile(filePath, new Uint8Array(bytes));
  return filePath;
}

const runUpload = (payload: PreparedFileUploadPayload, onProgress?: (progress: number) => void) =>
  Effect.runPromise(
    uploadPreparedFile(payload, onProgress, fetchMock).pipe(Effect.provide(NodeFileSystem.layer)),
  );

beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal("fetch", fetchMock);
});

describe("uploadPreparedFile", () => {
  it("uploads managed file bytes without re-encoding them", async () => {
    const bytes = new TextEncoder().encode("héllo 👋\n");
    const filePath = await uploadFile(bytes);
    let uploaded = new Uint8Array();
    fetchMock.mockImplementationOnce(async (_url, init) => {
      uploaded = new Uint8Array(await new Response(init?.body).arrayBuffer());
      return Response.json({ id: "drive-text-id" });
    });

    const result = await runUpload({
      id: "0d1e2f3a-4567-4890-8abc-def012345678",
      filePath,
      byteSize: bytes.byteLength,
      prepared: {
        storageProvider: "GOOGLE_DRIVE",
        storageObjectId: null,
        upload: {
          method: "PUT",
          url: "https://upload.example/drive",
          headers: [{ name: "Content-Type", value: "text/plain; charset=utf-8" }],
          strategy: { type: "single_request" },
        },
        expiresAt: null,
      },
    });

    expect(result).toEqual({ storageObjectId: "drive-text-id" });
    expect(uploaded).toEqual(bytes);
  });

  it("honors a prepared raw single-request upload and keeps the prepared Dropbox path", async () => {
    const filePath = await uploadFile([1, 2, 3]);
    let body: ReadonlyArray<number> = [];
    fetchMock.mockImplementationOnce(async (_url, init) => {
      const requestBody = init?.body;
      if (!(requestBody instanceof Blob)) throw new Error("Expected request body.");
      body = Array.from(new Uint8Array(await requestBody.arrayBuffer()));
      return Response.json({ id: "ignored-provider-id" });
    });

    const result = await runUpload({
      id: "0d1e2f3a-4567-4890-8abc-def012345678",
      filePath,
      byteSize: 3,
      prepared: {
        storageProvider: "DROPBOX",
        storageObjectId: "/0d1e2f3a-4567-4890-8abc-def012345678/upload.bin",
        upload: {
          method: "POST",
          url: "https://upload.example/dropbox",
          headers: [{ name: "Content-Type", value: "application/octet-stream" }],
          strategy: { type: "single_request" },
        },
        expiresAt: null,
      },
    });

    expect(result).toEqual({
      storageObjectId: "/0d1e2f3a-4567-4890-8abc-def012345678/upload.bin",
    });
    const [url, init] = fetchMock.mock.calls[0] ?? [];
    expect(url).toBe("https://upload.example/dropbox");
    expect(init).toMatchObject({
      method: "POST",
      headers: {
        "Content-Type": "application/octet-stream",
      },
    });
    expect(init?.body).toBeDefined();
    expect(init?.body).toBeInstanceOf(Blob);
    expect(body).toEqual([1, 2, 3]);
  });

  it("persists the ID returned by a Google Drive upload", async () => {
    const filePath = await uploadFile([1, 2, 3]);
    const progress = vi.fn();
    fetchMock
      .mockResolvedValueOnce(new Response(null, { status: 308, headers: { Range: "bytes=0-1" } }))
      .mockResolvedValueOnce(Response.json({ id: "drive-file-id" }));

    await expect(
      runUpload(
        {
          id: "0d1e2f3a-4567-4890-8abc-def012345678",
          filePath,
          byteSize: 3,
          prepared: {
            storageProvider: "GOOGLE_DRIVE",
            storageObjectId: null,
            upload: {
              method: "PUT",
              url: "https://upload.example/drive",
              headers: [{ name: "Content-Type", value: "text/plain" }],
              strategy: { type: "byte_range", maxPartByteSize: 2, partByteMultiple: 2 },
            },
            expiresAt: null,
          },
        },
        progress,
      ),
    ).resolves.toEqual({ storageObjectId: "drive-file-id" });
    expect(fetchMock.mock.calls.map(([, init]) => init?.headers)).toEqual([
      {
        "Content-Type": "text/plain",
        "Content-Range": "bytes 0-1/3",
      },
      {
        "Content-Type": "text/plain",
        "Content-Range": "bytes 2-2/3",
      },
    ]);
    expect(progress.mock.calls).toEqual([[0], [66], [100]]);
  });

  it("uploads OneDrive byte ranges and reads the final item ID", async () => {
    const filePath = await uploadFile([1, 2, 3, 4, 5]);
    fetchMock
      .mockResolvedValueOnce(Response.json({ nextExpectedRanges: ["4-"] }, { status: 202 }))
      .mockResolvedValueOnce(Response.json({ id: "one-drive-item" }));

    const result = await runUpload({
      id: "0d1e2f3a-4567-4890-8abc-def012345678",
      filePath,
      byteSize: 5,
      prepared: {
        storageProvider: "ONE_DRIVE",
        storageObjectId: null,
        upload: {
          method: "PUT",
          url: "https://upload.example/onedrive",
          headers: [],
          strategy: { type: "byte_range", maxPartByteSize: 4, partByteMultiple: 2 },
        },
        expiresAt: "2026-07-10T12:00:00.000Z",
      },
    });

    expect(result).toEqual({ storageObjectId: "one-drive-item" });
    expect(fetchMock.mock.calls.map(([, init]) => init?.headers)).toEqual([
      { "Content-Range": "bytes 0-3/5" },
      { "Content-Range": "bytes 4-4/5" },
    ]);
  });

  it("reports expired links as retryable upload failures", async () => {
    const filePath = await uploadFile([1]);
    fetchMock.mockResolvedValueOnce(new Response("expired", { status: 410 }));

    await expect(
      runUpload({
        id: "0d1e2f3a-4567-4890-8abc-def012345678",
        filePath,
        byteSize: 1,
        prepared: {
          storageProvider: "GOOGLE_DRIVE",
          storageObjectId: null,
          upload: {
            method: "PUT",
            url: "https://upload.example/expired",
            headers: [],
            strategy: { type: "single_request" },
          },
          expiresAt: null,
        },
      }),
    ).rejects.toThrow("The upload provider rejected the file (410).");
  });

  it("aborts an in-flight provider request when the upload Effect is interrupted", async () => {
    const filePath = await uploadFile([1, 2, 3]);
    let aborted = false;
    fetchMock.mockImplementationOnce(
      (_url, init) =>
        new Promise((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => {
            aborted = true;
            reject(new Error("aborted"));
          });
        }),
    );

    const upload = Effect.runFork(
      uploadPreparedFile(
        {
          id: "0d1e2f3a-4567-4890-8abc-def012345678",
          filePath,
          byteSize: 3,
          prepared: {
            storageProvider: "GOOGLE_DRIVE",
            storageObjectId: null,
            upload: {
              method: "PUT",
              url: "https://upload.example/drive",
              headers: [],
              strategy: { type: "single_request" },
            },
            expiresAt: null,
          },
        },
        undefined,
        fetchMock,
      ).pipe(Effect.provide(NodeFileSystem.layer)),
    );
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledOnce());
    await Effect.runPromise(Fiber.interrupt(upload));

    expect(aborted).toBe(true);
  });

  it("rejects a non-progressing OneDrive response", async () => {
    const filePath = await uploadFile([1, 2]);
    fetchMock.mockResolvedValueOnce(Response.json({ nextExpectedRanges: ["0-"] }, { status: 202 }));

    await expect(
      runUpload({
        id: "0d1e2f3a-4567-4890-8abc-def012345678",
        filePath,
        byteSize: 2,
        prepared: {
          storageProvider: "GOOGLE_DRIVE",
          storageObjectId: null,
          upload: {
            method: "PUT",
            url: "https://upload.example/drive",
            headers: [],
            strategy: { type: "byte_range", maxPartByteSize: 2, partByteMultiple: 2 },
          },
          expiresAt: null,
        },
      }),
    ).rejects.toThrow("The upload session stopped advancing.");
  });

  it("rejects a non-progressing Google Drive response", async () => {
    const filePath = await uploadFile([1, 2]);
    fetchMock
      .mockResolvedValueOnce(new Response(null, { status: 308, headers: { Range: "bytes=0-0" } }))
      .mockResolvedValueOnce(new Response(null, { status: 308, headers: { Range: "bytes=0-0" } }));

    await expect(
      runUpload({
        id: "0d1e2f3a-4567-4890-8abc-def012345678",
        filePath,
        byteSize: 2,
        prepared: {
          storageProvider: "GOOGLE_DRIVE",
          storageObjectId: null,
          upload: {
            method: "PUT",
            url: "https://upload.example/drive",
            headers: [],
            strategy: { type: "byte_range", maxPartByteSize: 1, partByteMultiple: 1 },
          },
          expiresAt: null,
        },
      }),
    ).rejects.toThrow("The upload session stopped advancing.");
  });

  it("reports nested Electron network codes without exposing the upload link", async () => {
    const filePath = await uploadFile([1]);
    const failure = Object.assign(new Error("https://upload.example/secret"), {
      name: "HttpError",
      code: -2,
      cause: Object.assign(new Error("net::ERR_CONNECTION_REFUSED"), { code: "ECONNREFUSED" }),
    });
    fetchMock.mockRejectedValueOnce(failure);

    await expect(
      runUpload({
        id: "0d1e2f3a-4567-4890-8abc-def012345678",
        filePath,
        byteSize: 1,
        prepared: {
          storageProvider: "GOOGLE_DRIVE",
          storageObjectId: null,
          upload: {
            method: "PUT",
            url: "https://upload.example/secret",
            headers: [],
            strategy: { type: "single_request" },
          },
          expiresAt: null,
        },
      }),
    ).rejects.toThrow("HttpError code -2; Error code ECONNREFUSED net::ERR_CONNECTION_REFUSED");
  });
});
