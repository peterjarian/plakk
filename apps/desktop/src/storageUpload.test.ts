import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { uploadPreparedFile } from "./storageUpload.ts";

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
    fetchMock
      .mockResolvedValueOnce(new Response(null, { status: 308, headers: { Range: "bytes=0-1" } }))
      .mockResolvedValueOnce(Response.json({ id: "drive-file-id" }));

    await expect(
      uploadPreparedFile({
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
      }),
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
