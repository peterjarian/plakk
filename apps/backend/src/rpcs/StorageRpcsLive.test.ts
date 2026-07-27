import { CurrentUser } from "@plakk/shared/PlakkApi";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Effect from "effect/Effect";
import { FetchHttpClient, HttpClient } from "effect/unstable/http";

import { StorageProvider } from "../storage/StorageProvider.ts";
import { StorageRpcsLive, storageProviderReturnUrl } from "./StorageRpcsLive.ts";

const storage = StorageProvider.of({
  deleteObject: () => Effect.void,
  downloadObject: () => Effect.succeed(new Uint8Array()),
  ensureConnected: () => Effect.void,
  getDestinationUrl: () => Effect.succeed("https://drive.example/folder"),
  getLinkedProvider: () => Effect.succeed(null),
  getDownloadTarget: () => Effect.succeed({ url: "https://download.example", headers: [] }),
  getDownloadUrl: () => Effect.succeed("https://download.example"),
  prepareUpload: () =>
    Effect.succeed({
      storageProvider: "GOOGLE_DRIVE",
      storageObjectId: null,
      upload: {
        method: "PUT",
        url: "https://upload.example",
        headers: [],
        strategy: { type: "single_request" },
      },
      expiresAt: null,
    }),
});

const fetchMock = vi.fn<typeof fetch>();

beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

const run = <A, E>(
  effect: Effect.Effect<A, E, CurrentUser | StorageProvider | HttpClient.HttpClient>,
) =>
  Effect.runPromise(
    effect.pipe(
      Effect.provideService(CurrentUser, { id: "user-account-bound" }),
      Effect.provideService(StorageProvider, storage),
      Effect.provide(FetchHttpClient.layer),
      Effect.provideService(
        ConfigProvider.ConfigProvider,
        ConfigProvider.fromEnv({
          env: {
            PLAKK_WEB_ORIGIN: "https://app.plakk.io",
            WORKOS_API_KEY: "workos-server-secret",
          },
        }),
      ),
    ),
  );

describe("storage authorization", () => {
  it.each([
    {
      origin: "WEB" as const,
      returnTo:
        "https://app.plakk.io/storage?provider=GOOGLE_DRIVE&origin=web&confirmation=provider",
    },
    {
      origin: "DESKTOP" as const,
      returnTo:
        "https://app.plakk.io/storage?provider=GOOGLE_DRIVE&origin=desktop&confirmation=provider",
    },
  ])("binds a $origin authorization request to the account and trusted return", async (example) => {
    fetchMock.mockResolvedValue(Response.json({ url: "https://api.workos.com/provider-redirect" }));

    await expect(
      run(
        StorageRpcsLive.BeginStorageProviderLink({
          storageProvider: "GOOGLE_DRIVE",
          origin: example.origin,
        }),
      ),
    ).resolves.toEqual({ url: "https://api.workos.com/provider-redirect" });

    const [request, init] = fetchMock.mock.calls[0] ?? [];
    const workosRequest = new Request(request as RequestInfo, init);
    expect(workosRequest.url).toBe(
      "https://api.workos.com/data-integrations/google-drive/authorize",
    );
    expect(workosRequest.headers.get("authorization")).toBe("Bearer workos-server-secret");
    expect(await workosRequest.json()).toEqual({
      user_id: "user-account-bound",
      return_to: example.returnTo,
    });
  });

  it("derives only an exact same-origin Web return", () => {
    expect(storageProviderReturnUrl("https://app.plakk.io", "DROPBOX", "DESKTOP")).toBe(
      "https://app.plakk.io/storage?provider=DROPBOX&origin=desktop&confirmation=provider",
    );

    for (const origin of [
      "https://app.plakk.io/other",
      "https://user@app.plakk.io",
      "plakk://storage",
    ]) {
      expect(() => storageProviderReturnUrl(origin, "DROPBOX", "WEB")).toThrow("PLAKK_WEB_ORIGIN");
    }
  });

  it("requires HTTPS for a production return", () => {
    expect(() =>
      storageProviderReturnUrl("http://app.plakk.io", "GOOGLE_DRIVE", "WEB", true),
    ).toThrow("exact HTTPS origin in production");
    expect(storageProviderReturnUrl("https://app.plakk.io", "GOOGLE_DRIVE", "WEB", true)).toBe(
      "https://app.plakk.io/storage?provider=GOOGLE_DRIVE&origin=web&confirmation=provider",
    );
  });
});

describe("authoritative storage status", () => {
  it("reads the connected account for the authenticated WorkOS user", async () => {
    fetchMock.mockResolvedValue(Response.json({ state: "connected" }));

    await expect(
      run(
        StorageRpcsLive.GetStorageProviderStatus({
          storageProvider: "ONE_DRIVE",
        }),
      ),
    ).resolves.toEqual({
      storageProvider: "ONE_DRIVE",
      status: "CONNECTED",
      externalDestinationUrl: "https://drive.example/folder",
    });

    const [request, init] = fetchMock.mock.calls[0] ?? [];
    const workosRequest = new Request(request as RequestInfo, init);
    expect(workosRequest.url).toBe(
      "https://api.workos.com/user_management/users/user-account-bound/connected_accounts/microsoft-onedrive",
    );
    expect(workosRequest.headers.get("authorization")).toBe("Bearer workos-server-secret");
  });

  it("treats missing and reauthorization-required accounts as unconfirmed", async () => {
    fetchMock
      .mockResolvedValueOnce(new Response(null, { status: 404 }))
      .mockResolvedValueOnce(Response.json({ state: "needs_reauthorization" }));

    await expect(
      run(
        StorageRpcsLive.GetStorageProviderStatus({
          storageProvider: "DROPBOX",
        }),
      ),
    ).resolves.toEqual({
      storageProvider: "DROPBOX",
      status: "NOT_CONNECTED",
      externalDestinationUrl: null,
    });
    await expect(
      run(
        StorageRpcsLive.GetStorageProviderStatus({
          storageProvider: "DROPBOX",
        }),
      ),
    ).resolves.toEqual({
      storageProvider: "DROPBOX",
      status: "NEEDS_REAUTHORIZATION",
      externalDestinationUrl: null,
    });
  });

  it("fails closed when WorkOS status cannot be read", async () => {
    fetchMock.mockResolvedValue(new Response(null, { status: 503 }));

    await expect(
      run(
        StorageRpcsLive.GetStorageProviderStatus({
          storageProvider: "GOOGLE_DRIVE",
        }),
      ),
    ).rejects.toThrow();
  });
});
