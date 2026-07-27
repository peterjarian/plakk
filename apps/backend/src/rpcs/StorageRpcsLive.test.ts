import { CurrentUser } from "@plakk/shared/PlakkApi";
import { describe, expect, it, vi } from "vite-plus/test";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Effect from "effect/Effect";

import { StorageLifecycle } from "../storage/StorageLifecycle.ts";
import { StorageProvider } from "../storage/StorageProvider.ts";
import { StorageRpcsLive, storageProviderReturnUrl } from "./StorageRpcsLive.ts";

const lifecycle = (overrides: Partial<StorageLifecycle["Service"]> = {}) =>
  StorageLifecycle.of({
    assertCommandsAllowed: () => Effect.void,
    beginAuthorization: () => Effect.succeed({ url: "https://api.workos.com/provider-redirect" }),
    beginCleanup: (input) => Effect.succeed({ action: input.action, outcome: "COMPLETED" }),
    getManagementState: () =>
      Effect.succeed({
        affectedSnippetCount: 2,
        cleanup: null,
        connectionStatus: "CONNECTED",
        externalDestinationUrl: "https://drive.example/folder",
        storageProvider: "GOOGLE_DRIVE",
      }),
    getProviderStatus: (_, storageProvider) =>
      Effect.succeed({
        externalDestinationUrl: "https://drive.example/folder",
        status: "CONNECTED",
        storageProvider,
      }),
    retryCleanup: () => Effect.succeed({ action: "UNLINK", outcome: "COMPLETED" }),
    ...overrides,
  });

const storage = StorageProvider.of({
  beginAuthorization: () => Effect.succeed({ url: "https://workos.example/authorize" }),
  deleteObject: () => Effect.void,
  disconnect: () => Effect.void,
  downloadObject: () => Effect.succeed(new Uint8Array()),
  ensureConnected: () => Effect.void,
  getDestinationUrl: () => Effect.succeed("https://drive.example/folder"),
  getDownloadTarget: () => Effect.succeed({ url: "https://download.example", headers: [] }),
  getDownloadUrl: () => Effect.succeed("https://download.example"),
  getLinkedProvider: () => Effect.succeed("GOOGLE_DRIVE"),
  getStatus: (input) =>
    Effect.succeed({
      externalDestinationUrl: "https://drive.example/folder",
      status: "CONNECTED",
      storageProvider: input.storageProvider,
    }),
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

const run = <A, E>(
  effect: Effect.Effect<A, E, CurrentUser | StorageLifecycle | StorageProvider>,
  lifecycleService = lifecycle(),
) =>
  Effect.runPromise(
    effect.pipe(
      Effect.provideService(CurrentUser, { id: "user-account-bound" }),
      Effect.provideService(StorageLifecycle, lifecycleService),
      Effect.provideService(StorageProvider, storage),
      Effect.provideService(
        ConfigProvider.ConfigProvider,
        ConfigProvider.fromEnv({
          env: {
            PLAKK_WEB_ORIGIN: "https://app.plakk.io",
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
    const beginAuthorization = vi.fn(() =>
      Effect.succeed({ url: "https://api.workos.com/provider-redirect" }),
    );

    await expect(
      run(
        StorageRpcsLive.BeginStorageProviderLink({
          storageProvider: "GOOGLE_DRIVE",
          origin: example.origin,
        }),
        lifecycle({ beginAuthorization }),
      ),
    ).resolves.toEqual({ url: "https://api.workos.com/provider-redirect" });

    expect(beginAuthorization).toHaveBeenCalledWith(
      "user-account-bound",
      "GOOGLE_DRIVE",
      example.returnTo,
    );
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
  });
});

describe("authoritative storage management", () => {
  it("reads provider status through the backend provider owner", async () => {
    const getProviderStatus = vi.fn(
      (_: string, storageProvider: "DROPBOX" | "GOOGLE_DRIVE" | "ONE_DRIVE") =>
        Effect.succeed({
          externalDestinationUrl: "https://drive.example/folder",
          status: "CONNECTED" as const,
          storageProvider,
        }),
    );
    await expect(
      run(
        StorageRpcsLive.GetStorageProviderStatus({
          storageProvider: "ONE_DRIVE",
        }),
        lifecycle({ getProviderStatus }),
      ),
    ).resolves.toEqual({
      externalDestinationUrl: "https://drive.example/folder",
      status: "CONNECTED",
      storageProvider: "ONE_DRIVE",
    });
    expect(getProviderStatus).toHaveBeenCalledWith("user-account-bound", "ONE_DRIVE");
  });

  it("delegates exact-count cleanup and retry to the lifecycle owner", async () => {
    const beginCleanup = vi.fn(
      (input: Parameters<StorageLifecycle["Service"]["beginCleanup"]>[0]) =>
        Effect.succeed({ action: input.action, outcome: "COMPLETED" as const }),
    );
    const retryCleanup = vi.fn(() =>
      Effect.succeed({ action: "SWITCH" as const, outcome: "COMPLETED" as const }),
    );
    const service = lifecycle({ beginCleanup, retryCleanup });

    await expect(
      run(
        StorageRpcsLive.BeginStorageCleanup({
          action: "SWITCH",
          confirmation: "DELETE",
          expectedSnippetCount: 2,
          storageProvider: "GOOGLE_DRIVE",
        }),
        service,
      ),
    ).resolves.toEqual({ action: "SWITCH", outcome: "COMPLETED" });
    expect(beginCleanup).toHaveBeenCalledWith({
      action: "SWITCH",
      expectedSnippetCount: 2,
      storageProvider: "GOOGLE_DRIVE",
      workosUserId: "user-account-bound",
    });

    await expect(
      run(
        StorageRpcsLive.RetryStorageCleanup({
          storageProvider: "GOOGLE_DRIVE",
        }),
        service,
      ),
    ).resolves.toEqual({ action: "SWITCH", outcome: "COMPLETED" });
    expect(retryCleanup).toHaveBeenCalledWith("user-account-bound", "GOOGLE_DRIVE");
  });
});
