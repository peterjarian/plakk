import { beforeEach, describe, expect, it, vi } from "vite-plus/test";
import * as Effect from "effect/Effect";
import { FetchHttpClient } from "effect/unstable/http";

import { DropboxStorageProvider } from "./DropboxStorageProvider.ts";
import { GoogleDriveStorageProvider } from "./GoogleDriveStorageProvider.ts";
import { OneDriveStorageProvider } from "./OneDriveStorageProvider.ts";
import type { PrepareStorageUploadInput } from "./types.ts";

const input = {
  accessToken: "token",
  snippetId: "0d1e2f3a-4567-4890-8abc-def012345678",
  fileName: "folder/file.txt",
  byteSize: 4,
  contentType: "text/plain",
} satisfies Omit<PrepareStorageUploadInput, "storageProvider">;

const fetchMock = vi.fn<typeof fetch>();

beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal("fetch", fetchMock);
});

const firstFetchRequest = () => {
  const [request, init] = vi.mocked(fetch).mock.calls[0] ?? [];
  return new Request(request as RequestInfo, init);
};

describe("storage upload providers", () => {
  it("creates a Dropbox temporary upload link", async () => {
    fetchMock.mockResolvedValue(Response.json({ link: "https://dropbox-upload.example" }));

    const upload = await Effect.runPromise(
      DropboxStorageProvider.prepareUpload({
        ...input,
        storageProvider: "DROPBOX",
      }).pipe(Effect.provide(FetchHttpClient.layer)),
    );

    expect(upload).toMatchObject({
      storageObjectId: "/0d1e2f3a-4567-4890-8abc-def012345678/folder/file.txt",
      upload: {
        method: "POST",
        url: "https://dropbox-upload.example",
        headers: [{ name: "Content-Type", value: "application/octet-stream" }],
        strategy: { type: "single_request" },
      },
    });
    const request = firstFetchRequest();
    expect(request.url).toBe("https://api.dropboxapi.com/2/files/get_temporary_upload_link");
    expect(await request.json()).toEqual({
      commit_info: {
        path: "/0d1e2f3a-4567-4890-8abc-def012345678/folder/file.txt",
        mode: "add",
        autorename: false,
        mute: false,
        strict_conflict: false,
      },
    });
  });

  it("creates a Google Drive resumable upload session", async () => {
    fetchMock.mockResolvedValue(
      new Response(null, {
        status: 200,
        headers: { Location: "https://google-upload.example" },
      }),
    );

    const upload = await Effect.runPromise(
      GoogleDriveStorageProvider.prepareUpload({
        ...input,
        storageProvider: "GOOGLE_DRIVE",
      }).pipe(Effect.provide(FetchHttpClient.layer)),
    );

    expect(upload).toMatchObject({
      storageObjectId: null,
      upload: { method: "PUT", url: "https://google-upload.example" },
    });
  });

  it("creates a OneDrive upload session", async () => {
    fetchMock.mockResolvedValue(
      Response.json({
        uploadUrl: "https://onedrive-upload.example",
        expirationDateTime: "2026-07-08T12:00:00Z",
      }),
    );

    const upload = await Effect.runPromise(
      OneDriveStorageProvider.prepareUpload({
        ...input,
        storageProvider: "ONE_DRIVE",
      }).pipe(Effect.provide(FetchHttpClient.layer)),
    );

    expect(upload).toMatchObject({
      storageObjectId: null,
      upload: {
        method: "PUT",
        url: "https://onedrive-upload.example",
        headers: [],
        strategy: {
          type: "byte_range",
          maxPartByteSize: 62_586_880,
          partByteMultiple: 327_680,
        },
      },
      expiresAt: "2026-07-08T12:00:00Z",
    });
  });
});
