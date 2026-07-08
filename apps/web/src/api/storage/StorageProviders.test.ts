import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import * as Effect from "effect/Effect";

import { DropboxStorageProvider } from "./DropboxStorageProvider.ts";
import { GoogleDriveStorageProvider } from "./GoogleDriveStorageProvider.ts";
import { OneDriveStorageProvider } from "./OneDriveStorageProvider.ts";
import type { PrepareStorageUploadInput } from "./types.ts";

const input = {
  accessToken: "token",
  fileName: "folder/file.txt",
  byteSize: 4,
  contentType: "text/plain",
} satisfies Omit<PrepareStorageUploadInput, "storageProvider">;

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("storage upload providers", () => {
  it("creates a Dropbox temporary upload link", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => Response.json({ link: "https://dropbox-upload.example" })),
    );

    const upload = await Effect.runPromise(
      DropboxStorageProvider.prepareUpload({
        ...input,
        storageProvider: "DROPBOX",
      }),
    );

    expect(upload).toMatchObject({
      storageObjectId: "/folder/file.txt",
      upload: {
        method: "POST",
        url: "https://dropbox-upload.example",
        headers: [{ name: "Content-Type", value: "application/octet-stream" }],
        strategy: { type: "single_request" },
      },
    });
    const [url, init] = vi.mocked(fetch).mock.calls[0] ?? [];
    expect(url).toBe("https://api.dropboxapi.com/2/files/get_temporary_upload_link");
    expect(await new Request(url as RequestInfo, init).json()).toEqual({
      commit_info: {
        path: "/folder/file.txt",
        mode: "add",
        autorename: false,
        mute: false,
        strict_conflict: false,
      },
    });
  });

  it("creates a Google Drive resumable upload session", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(null, {
            status: 200,
            headers: { Location: "https://google-upload.example" },
          }),
      ),
    );

    const upload = await Effect.runPromise(
      GoogleDriveStorageProvider.prepareUpload({
        ...input,
        storageProvider: "GOOGLE_DRIVE",
      }),
    );

    expect(upload).toMatchObject({
      storageObjectId: null,
      upload: { method: "PUT", url: "https://google-upload.example" },
    });
  });

  it("creates a OneDrive upload session", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        Response.json({
          uploadUrl: "https://onedrive-upload.example",
          expirationDateTime: "2026-07-08T12:00:00Z",
        }),
      ),
    );

    const upload = await Effect.runPromise(
      OneDriveStorageProvider.prepareUpload({
        ...input,
        storageProvider: "ONE_DRIVE",
      }),
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
