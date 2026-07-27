import { beforeEach, describe, expect, it, vi } from "vite-plus/test";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { FetchHttpClient } from "effect/unstable/http";

import { DropboxStorageProvider } from "./providers/DropboxStorageProvider.ts";
import { GoogleDriveStorageProvider } from "./providers/GoogleDriveStorageProvider.ts";
import { OneDriveStorageProvider } from "./providers/OneDriveStorageProvider.ts";
import { type PrepareStorageUploadInput, StorageProvider } from "./StorageProvider.ts";
import { StorageProviderLive } from "./StorageProviderLive.ts";

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

const fetchRequest = (index: number) => {
  const [request, init] = vi.mocked(fetch).mock.calls[index] ?? [];
  return new Request(request as RequestInfo, init);
};

const StorageProviderTestLive = StorageProviderLive.pipe(Layer.provide(FetchHttpClient.layer));

const useStorageProvider = <A, E>(
  use: (storage: StorageProvider["Service"]) => Effect.Effect<A, E>,
) =>
  Effect.runPromise(
    Effect.gen(function* () {
      const storage = yield* StorageProvider;
      return yield* use(storage);
    }).pipe(
      Effect.provide(StorageProviderTestLive),
      Effect.provideService(
        ConfigProvider.ConfigProvider,
        ConfigProvider.fromEnv({
          env: {
            WORKOS_API_KEY: "workos-api-key",
            WORKOS_CLIENT_ID: "workos-client-id",
          },
        }),
      ),
    ),
  );

const linkedProvider = (workosUserId: string) =>
  useStorageProvider((storage) => storage.getLinkedProvider(workosUserId));

describe("linked storage provider", () => {
  it("resolves the connected provider separately for each WorkOS user", async () => {
    fetchMock
      .mockResolvedValueOnce(
        Response.json({
          data: [
            { slug: "google-drive", connected_account: { state: "connected" } },
            { slug: "dropbox", connected_account: null },
          ],
        }),
      )
      .mockResolvedValueOnce(
        Response.json({
          data: [
            { slug: "google-drive", connected_account: null },
            { slug: "dropbox", connected_account: { state: "needs_reauthorization" } },
          ],
        }),
      );

    await expect(linkedProvider("google-user")).resolves.toBe("GOOGLE_DRIVE");
    await expect(linkedProvider("dropbox-user")).resolves.toBe("DROPBOX");

    expect(fetchRequest(0).url).toBe(
      "https://api.workos.com/user_management/users/google-user/data_providers",
    );
    expect(fetchRequest(1).url).toBe(
      "https://api.workos.com/user_management/users/dropbox-user/data_providers",
    );
  });

  it("returns no provider when the user has not linked storage", async () => {
    fetchMock.mockResolvedValue(
      Response.json({
        data: [{ slug: "google-drive", connected_account: null }, { slug: "microsoft-onedrive" }],
      }),
    );

    await expect(linkedProvider("unlinked-user")).resolves.toBeNull();
  });

  it("rejects ambiguous accounts instead of choosing a default provider", async () => {
    fetchMock.mockResolvedValue(
      Response.json({
        data: [
          { slug: "google-drive", connected_account: { state: "connected" } },
          { slug: "dropbox", connected_account: { state: "connected" } },
        ],
      }),
    );

    await expect(linkedProvider("ambiguous-user")).rejects.toMatchObject({
      _tag: "StorageCredentialsError",
      message: "More than one storage provider is linked.",
    });
  });
});

describe("WorkOS-connected storage authority", () => {
  it("requests account-bound authorization without exposing credentials", async () => {
    fetchMock.mockResolvedValue(Response.json({ url: "https://api.workos.com/provider-redirect" }));

    await expect(
      useStorageProvider((storage) =>
        storage.beginAuthorization({
          returnTo: "https://app.plakk.io/storage?confirmation=provider",
          storageProvider: "GOOGLE_DRIVE",
          workosUserId: "bound-user",
        }),
      ),
    ).resolves.toEqual({ url: "https://api.workos.com/provider-redirect" });

    const request = fetchRequest(0);
    expect(request.url).toBe("https://api.workos.com/data-integrations/google-drive/authorize");
    expect(await request.json()).toEqual({
      return_to: "https://app.plakk.io/storage?confirmation=provider",
      user_id: "bound-user",
    });
  });

  it("reports reauthorization and disconnects the same connected account", async () => {
    fetchMock
      .mockResolvedValueOnce(Response.json({ state: "needs_reauthorization" }))
      .mockResolvedValueOnce(new Response(null, { status: 204 }));

    await expect(
      useStorageProvider((storage) =>
        storage.getStatus({
          storageProvider: "DROPBOX",
          workosUserId: "bound-user",
        }),
      ),
    ).resolves.toEqual({
      externalDestinationUrl: null,
      status: "NEEDS_REAUTHORIZATION",
      storageProvider: "DROPBOX",
    });
    await expect(
      useStorageProvider((storage) =>
        storage.disconnect({
          storageProvider: "DROPBOX",
          workosUserId: "bound-user",
        }),
      ),
    ).resolves.toBeUndefined();
    expect(fetchRequest(1).url).toBe(
      "https://api.workos.com/user_management/users/bound-user/connected_accounts/dropbox",
    );
  });
});

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
    const request = fetchRequest(0);
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
    fetchMock
      .mockResolvedValueOnce(Response.json({ files: [{ id: "plakk-folder" }] }))
      .mockResolvedValueOnce(
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
      upload: {
        method: "PUT",
        url: "https://google-upload.example",
        strategy: {
          type: "byte_range",
          maxPartByteSize: 16_777_216,
          partByteMultiple: 262_144,
        },
      },
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(new URL(fetchRequest(0).url).searchParams.get("q")).toBe(
      "mimeType = 'application/vnd.google-apps.folder' and name = 'Plakk' and 'root' in parents and trashed = false",
    );
    expect(await fetchRequest(1).json()).toEqual({
      name: "folder/file.txt",
      mimeType: "text/plain",
      parents: ["plakk-folder"],
    });
  });

  it("creates the Plakk folder when Google Drive does not have one", async () => {
    fetchMock
      .mockResolvedValueOnce(Response.json({ files: [] }))
      .mockResolvedValueOnce(Response.json({ id: "plakk-folder" }));

    const destination = await Effect.runPromise(
      GoogleDriveStorageProvider.getDestination({ accessToken: "token" }).pipe(
        Effect.provide(FetchHttpClient.layer),
      ),
    );

    expect(destination).toEqual({
      url: "https://drive.google.com/drive/folders/plakk-folder",
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const request = fetchRequest(1);
    expect(request.url).toContain("https://www.googleapis.com/drive/v3/files?fields=id");
    expect(await request.json()).toEqual({
      name: "Plakk",
      mimeType: "application/vnd.google-apps.folder",
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

describe("storage deletion providers", () => {
  it.each([
    {
      name: "Google Drive",
      deleteObject: GoogleDriveStorageProvider.deleteObject,
      storageProvider: "GOOGLE_DRIVE" as const,
      storageObjectId: "drive-id",
      expectedUrl: "https://www.googleapis.com/drive/v3/files/drive-id",
    },
    {
      name: "OneDrive",
      deleteObject: OneDriveStorageProvider.deleteObject,
      storageProvider: "ONE_DRIVE" as const,
      storageObjectId: "one-id",
      expectedUrl: "https://graph.microsoft.com/v1.0/me/drive/items/one-id",
    },
  ])("deletes one $name object with its connected token", async (provider) => {
    fetchMock.mockResolvedValue(new Response(null, { status: 204 }));

    await Effect.runPromise(
      provider
        .deleteObject({
          accessToken: "secret-token",
          storageProvider: provider.storageProvider,
          storageObjectId: provider.storageObjectId,
        })
        .pipe(Effect.provide(FetchHttpClient.layer)),
    );

    const request = fetchRequest(0);
    expect(request.method).toBe("DELETE");
    expect(request.url).toBe(provider.expectedUrl);
    expect(request.headers.get("authorization")).toBe("Bearer secret-token");
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it("deletes one Dropbox object by its exact path", async () => {
    fetchMock.mockResolvedValue(Response.json({ metadata: {} }));

    await Effect.runPromise(
      DropboxStorageProvider.deleteObject({
        accessToken: "secret-token",
        storageProvider: "DROPBOX",
        storageObjectId: "/snippet/file.txt",
      }).pipe(Effect.provide(FetchHttpClient.layer)),
    );

    const request = fetchRequest(0);
    expect(request.method).toBe("POST");
    expect(request.url).toBe("https://api.dropboxapi.com/2/files/delete_v2");
    expect(request.headers.get("authorization")).toBe("Bearer secret-token");
    expect(await request.json()).toEqual({ path: "/snippet/file.txt" });
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it("treats an already-missing Dropbox object as completed cleanup", async () => {
    fetchMock.mockResolvedValue(
      Response.json({ error_summary: "path_lookup/not_found/..." }, { status: 409 }),
    );

    await expect(
      Effect.runPromise(
        DropboxStorageProvider.deleteObject({
          accessToken: "secret-token",
          storageProvider: "DROPBOX",
          storageObjectId: "/snippet/missing.txt",
        }).pipe(Effect.provide(FetchHttpClient.layer)),
      ),
    ).resolves.toBeUndefined();
  });

  it("does not suppress unrelated Dropbox conflict responses", async () => {
    fetchMock.mockResolvedValue(
      Response.json({ error_summary: "path_lookup/malformed_path/..." }, { status: 409 }),
    );

    await expect(
      Effect.runPromise(
        DropboxStorageProvider.deleteObject({
          accessToken: "secret-token",
          storageProvider: "DROPBOX",
          storageObjectId: "/snippet/malformed.txt",
        }).pipe(Effect.provide(FetchHttpClient.layer)),
      ),
    ).rejects.toMatchObject({
      _tag: "StorageProviderError",
      message: "Stored object deletion failed: 409",
    });
  });

  it("reports provider deletion failure without retrying", async () => {
    fetchMock.mockResolvedValue(new Response(null, { status: 503 }));

    await expect(
      Effect.runPromise(
        GoogleDriveStorageProvider.deleteObject({
          accessToken: "token",
          storageProvider: "GOOGLE_DRIVE",
          storageObjectId: "drive-id",
        }).pipe(Effect.provide(FetchHttpClient.layer)),
      ),
    ).rejects.toMatchObject({
      _tag: "StorageProviderError",
      message: "Stored object deletion failed: 503",
    });
    expect(fetchMock).toHaveBeenCalledOnce();
  });
});

describe("storage download providers", () => {
  it("returns an authorized Google Drive media target without downloading bytes", async () => {
    await expect(
      Effect.runPromise(
        GoogleDriveStorageProvider.getDownloadTarget({
          accessToken: "secret-token",
          storageProvider: "GOOGLE_DRIVE",
          storageObjectId: "drive-id",
        }),
      ),
    ).resolves.toEqual({
      url: "https://www.googleapis.com/drive/v3/files/drive-id?alt=media",
      headers: [{ name: "Authorization", value: "Bearer secret-token" }],
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each([
    {
      name: "Google Drive",
      getDownloadUrl: GoogleDriveStorageProvider.getDownloadUrl,
      storageProvider: "GOOGLE_DRIVE" as const,
      storageObjectId: "drive-id",
      response: { webContentLink: "https://google.example/signed" },
      expectedUrl: "https://www.googleapis.com/drive/v3/files/drive-id?fields=webContentLink",
    },
    {
      name: "OneDrive",
      getDownloadUrl: OneDriveStorageProvider.getDownloadUrl,
      storageProvider: "ONE_DRIVE" as const,
      storageObjectId: "one-id",
      response: { "@microsoft.graph.downloadUrl": "https://onedrive.example/signed" },
      expectedUrl:
        "https://graph.microsoft.com/v1.0/me/drive/items/one-id?%24select=%40microsoft.graph.downloadUrl",
    },
    {
      name: "Dropbox",
      getDownloadUrl: DropboxStorageProvider.getDownloadUrl,
      storageProvider: "DROPBOX" as const,
      storageObjectId: "/snippet/file.png",
      response: { link: "https://dropbox.example/signed" },
      expectedUrl: "https://api.dropboxapi.com/2/files/get_temporary_link",
    },
  ])("returns a direct scoped download URL from $name", async (provider) => {
    fetchMock.mockResolvedValue(Response.json(provider.response));

    await expect(
      Effect.runPromise(
        provider
          .getDownloadUrl({
            accessToken: "secret-token",
            storageProvider: provider.storageProvider,
            storageObjectId: provider.storageObjectId,
          })
          .pipe(Effect.provide(FetchHttpClient.layer)),
      ),
    ).resolves.toContain("signed");

    const request = fetchRequest(0);
    expect(request.url).toBe(provider.expectedUrl);
    expect(request.headers.get("authorization")).toBe("Bearer secret-token");
    if (provider.storageProvider === "DROPBOX") {
      expect(await request.json()).toEqual({ path: provider.storageObjectId });
    }
  });

  it.each([
    {
      name: "Google Drive",
      download: GoogleDriveStorageProvider.download,
      storageProvider: "GOOGLE_DRIVE" as const,
      storageObjectId: "drive-id",
      expectedUrl: "https://www.googleapis.com/drive/v3/files/drive-id?alt=media",
    },
    {
      name: "OneDrive",
      download: OneDriveStorageProvider.download,
      storageProvider: "ONE_DRIVE" as const,
      storageObjectId: "one-id",
      expectedUrl: "https://graph.microsoft.com/v1.0/me/drive/items/one-id/content",
    },
    {
      name: "Dropbox",
      download: DropboxStorageProvider.download,
      storageProvider: "DROPBOX" as const,
      storageObjectId: "/snippet/text.txt",
      expectedUrl: "https://content.dropboxapi.com/2/files/download",
    },
  ])("downloads exact opaque bytes from $name", async (provider) => {
    const expected = new Uint8Array([0, 0xf0, 0x9f, 0x91, 0x8b, 0xff]);
    fetchMock.mockResolvedValue(new Response(expected));

    const bytes = await Effect.runPromise(
      provider
        .download({
          accessToken: "secret-token",
          storageProvider: provider.storageProvider,
          storageObjectId: provider.storageObjectId,
          expectedByteSize: expected.byteLength,
        })
        .pipe(Effect.provide(FetchHttpClient.layer)),
    );

    expect(bytes).toEqual(expected);
    const request = fetchRequest(0);
    expect(request.url).toBe(provider.expectedUrl);
    expect(request.headers.get("authorization")).toBe("Bearer secret-token");
    if (provider.storageProvider === "DROPBOX") {
      expect(request.headers.get("dropbox-api-arg")).toBe(
        JSON.stringify({ path: provider.storageObjectId }),
      );
    }
  });

  it.each([
    {
      name: "Google Drive",
      download: GoogleDriveStorageProvider.download,
      storageProvider: "GOOGLE_DRIVE" as const,
      response: new Response(null, { status: 404 }),
    },
    {
      name: "OneDrive",
      download: OneDriveStorageProvider.download,
      storageProvider: "ONE_DRIVE" as const,
      response: new Response(null, { status: 404 }),
    },
    {
      name: "Dropbox",
      download: DropboxStorageProvider.download,
      storageProvider: "DROPBOX" as const,
      response: Response.json({ error_summary: "path/not_found/..." }, { status: 409 }),
    },
  ])("turns a missing $name object into a typed not-found failure", async (provider) => {
    fetchMock.mockResolvedValue(provider.response);

    const failure = await Effect.runPromise(
      Effect.flip(
        provider
          .download({
            accessToken: "token",
            storageProvider: provider.storageProvider,
            storageObjectId: "missing",
            expectedByteSize: 1,
          })
          .pipe(Effect.provide(FetchHttpClient.layer)),
      ),
    );

    expect(failure._tag).toBe("StorageObjectNotFoundError");
  });

  it("does not misreport other Dropbox 409 errors as missing objects", async () => {
    fetchMock.mockResolvedValue(
      Response.json({ error_summary: "path/malformed_path/..." }, { status: 409 }),
    );

    const failure = await Effect.runPromise(
      Effect.flip(
        DropboxStorageProvider.download({
          accessToken: "token",
          storageProvider: "DROPBOX",
          storageObjectId: "invalid",
          expectedByteSize: 1,
        }).pipe(Effect.provide(FetchHttpClient.layer)),
      ),
    );

    expect(failure).toMatchObject({
      _tag: "StorageProviderError",
      message: "Stored object download failed: 409",
    });
  });

  it("stops a chunked provider response once it exceeds the expected size", async () => {
    fetchMock.mockResolvedValue(
      new Response(
        new ReadableStream({
          start(controller) {
            controller.enqueue(new Uint8Array([1, 2, 3]));
            controller.close();
          },
        }),
      ),
    );

    const failure = await Effect.runPromise(
      Effect.flip(
        GoogleDriveStorageProvider.download({
          accessToken: "token",
          storageProvider: "GOOGLE_DRIVE",
          storageObjectId: "oversized",
          expectedByteSize: 2,
        }).pipe(Effect.provide(FetchHttpClient.layer)),
      ),
    );

    expect(failure).toMatchObject({
      _tag: "StorageProviderError",
      message: "Stored object size does not match snippet metadata.",
    });
  });
});
