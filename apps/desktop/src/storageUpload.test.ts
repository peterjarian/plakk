import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { Effect } from "effect";

import { StorageUpload, uploadPreparedFile } from "./storageUpload.ts";

const fetchMock = vi.fn<typeof fetch>();

async function uploadFile(bytes: ReadonlyArray<number>) {
  const directory = await mkdtemp(join(tmpdir(), "plakk-upload-"));
  const filePath = join(directory, "upload.bin");
  await writeFile(filePath, new Uint8Array(bytes));
  return filePath;
}

beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal("fetch", fetchMock);
});

describe("uploadPreparedFile", () => {
  it("marks rejected prepared links stale so the engine can prepare again", async () => {
    const bytes = new Uint8Array([1]);
    fetchMock.mockResolvedValueOnce(new Response("reauthorize", { status: 403 }));

    const failure = await Effect.runPromise(
      Effect.flip(
        StorageUpload.use((storage) =>
          storage.upload(
            {
              id: "0d1e2f3a-4567-4890-8abc-def012345678",
              bytes,
              byteSize: 1,
              prepared: {
                storageProvider: "GOOGLE_DRIVE",
                storageObjectId: null,
                upload: {
                  method: "PUT",
                  url: "https://upload.example/forbidden",
                  headers: [],
                  strategy: { type: "single_request" },
                },
                expiresAt: null,
              },
            },
            () => undefined,
          ),
        ),
      ).pipe(Effect.provide(StorageUpload.layer(fetchMock))),
    );

    expect(failure).toMatchObject({
      _tag: "StorageUploadError",
      actionable: false,
      stalePreparation: true,
    });
  });

  it("uploads renderer-provided bytes without re-encoding them", async () => {
    const bytes = new TextEncoder().encode("héllo 👋\n");
    let uploaded = new Uint8Array();
    fetchMock.mockImplementationOnce(async (_url, init) => {
      uploaded = new Uint8Array(await new Response(init?.body).arrayBuffer());
      return Response.json({ id: "drive-text-id" });
    });

    const result = await uploadPreparedFile({
      id: "0d1e2f3a-4567-4890-8abc-def012345678",
      bytes,
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

    const result = await uploadPreparedFile({
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

  it("resumes after the provider's last acknowledged byte range", async () => {
    const filePath = await uploadFile([1, 2, 3]);
    const progress = vi.fn();
    fetchMock
      .mockResolvedValueOnce(new Response(null, { status: 308, headers: { Range: "bytes=0-1" } }))
      .mockResolvedValueOnce(Response.json({ id: "drive-file-id" }));

    await expect(
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
              headers: [{ name: "Content-Type", value: "text/plain" }],
              strategy: { type: "byte_range", maxPartByteSize: 2, partByteMultiple: 2 },
            },
            expiresAt: null,
            resume: true,
          },
        },
        progress,
      ),
    ).resolves.toEqual({ storageObjectId: "drive-file-id" });

    expect(fetchMock.mock.calls.map(([, init]) => init?.headers)).toEqual([
      { "Content-Type": "text/plain", "Content-Range": "bytes */3" },
      { "Content-Type": "text/plain", "Content-Range": "bytes 2-2/3" },
    ]);
    expect(progress.mock.calls).toEqual([[0], [66], [100]]);
  });

  it("uploads OneDrive byte ranges and reads the final item ID", async () => {
    const filePath = await uploadFile([1, 2, 3, 4, 5]);
    fetchMock
      .mockResolvedValueOnce(Response.json({ nextExpectedRanges: ["4-"] }, { status: 202 }))
      .mockResolvedValueOnce(Response.json({ id: "one-drive-item" }));

    const result = await uploadPreparedFile({
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

  it("continues a reused OneDrive session from its next expected range", async () => {
    const filePath = await uploadFile([1, 2, 3, 4, 5]);
    fetchMock
      .mockResolvedValueOnce(Response.json({ nextExpectedRanges: ["4-"] }))
      .mockResolvedValueOnce(Response.json({ id: "one-drive-item" }));

    await expect(
      uploadPreparedFile({
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
          resume: true,
        },
      }),
    ).resolves.toEqual({ storageObjectId: "one-drive-item" });

    expect(fetchMock.mock.calls.map(([, init]) => init?.method)).toEqual(["GET", "PUT"]);
    expect(fetchMock.mock.calls[1]?.[1]?.headers).toEqual({
      "Content-Range": "bytes 4-4/5",
    });
  });

  it("reports expired links as retryable upload failures", async () => {
    const filePath = await uploadFile([1]);
    fetchMock.mockResolvedValueOnce(new Response("expired", { status: 410 }));

    await expect(
      uploadPreparedFile({
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
    ).rejects.toThrow("Upload failed: 410 expired");
  });

  it("reports cancellation while an upload request is in flight", async () => {
    const filePath = await uploadFile([1, 2, 3]);
    const controller = new AbortController();
    fetchMock.mockImplementationOnce(
      (_url, init) =>
        new Promise((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => reject(new Error("aborted")));
        }),
    );

    const upload = uploadPreparedFile(
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
      controller.signal,
    );
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledOnce());
    controller.abort();

    await expect(upload).rejects.toThrow("Upload cancelled");
  });

  it("rejects a non-progressing OneDrive response", async () => {
    const filePath = await uploadFile([1, 2]);
    fetchMock.mockResolvedValueOnce(Response.json({ nextExpectedRanges: ["0-"] }, { status: 202 }));

    await expect(
      uploadPreparedFile({
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
    ).rejects.toThrow("Upload session stalled");
  });

  it("rejects a non-progressing Google Drive response", async () => {
    const filePath = await uploadFile([1, 2]);
    fetchMock
      .mockResolvedValueOnce(new Response(null, { status: 308, headers: { Range: "bytes=0-0" } }))
      .mockResolvedValueOnce(new Response(null, { status: 308, headers: { Range: "bytes=0-0" } }));

    await expect(
      uploadPreparedFile({
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
    ).rejects.toThrow("Upload session stalled");
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
      uploadPreparedFile({
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
