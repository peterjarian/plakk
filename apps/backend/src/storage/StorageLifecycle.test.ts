import type { StorageProvider as StorageProviderName } from "@plakk/shared";
import type { StorageProviderStatus } from "@plakk/shared/PlakkApi";
import { describe, expect, it, vi } from "vite-plus/test";
import * as Effect from "effect/Effect";
import * as DateTime from "effect/DateTime";
import * as Layer from "effect/Layer";

import { StorageProvider, StorageProviderError } from "./StorageProvider.ts";
import {
  StorageLifecycle,
  StorageLifecycleStore,
  type StorageCleanupRecord,
  type StorageCleanupSnippet,
} from "./StorageLifecycle.ts";

const owner = "user-storage-lifecycle";
const provider = "GOOGLE_DRIVE" as const;

const makeStore = (ids: ReadonlyArray<string>) => {
  let authorization: StorageProviderName | null = null;
  let cleanup: StorageCleanupRecord | null = null;
  let snippets: Array<StorageCleanupSnippet> = ids.map((id) => ({
    id,
    storageObjectId: `object-${id}`,
    storageProvider: provider,
  }));

  const service = StorageLifecycleStore.of({
    begin: (input) =>
      Effect.sync(() => {
        if (cleanup !== null) return cleanup;
        if (input.expectedSnippetCount !== snippets.length) return null;
        cleanup = {
          action: input.action,
          attemptId: null,
          lastFailure: null,
          leaseExpiresAt: null,
          storageProvider: input.storageProvider,
          totalSnippetCount: snippets.length,
          workosUserId: input.workosUserId,
        };
        return cleanup;
      }),
    claim: (workosUserId, storageProvider) =>
      Effect.sync(() => {
        if (
          cleanup === null ||
          cleanup.workosUserId !== workosUserId ||
          cleanup.storageProvider !== storageProvider ||
          cleanup.attemptId !== null
        ) {
          return null;
        }
        cleanup = {
          ...cleanup,
          attemptId: "00000000-0000-4000-8000-000000000001",
          leaseExpiresAt: DateTime.toDateUtc(DateTime.makeUnsafe("2026-07-27T14:00:00.000Z")),
        };
        return { cleanup, snippets };
      }),
    clearAuthorization: () =>
      Effect.sync(() => {
        authorization = null;
      }),
    complete: (workosUserId, attemptId) =>
      Effect.sync(() => {
        if (cleanup?.workosUserId === workosUserId && cleanup.attemptId === attemptId) {
          cleanup = null;
          return true;
        }
        return false;
      }),
    completeSnippet: (workosUserId, attemptId, snippetId) =>
      Effect.sync(() => {
        if (cleanup?.workosUserId === workosUserId && cleanup.attemptId === attemptId) {
          snippets = snippets.filter((snippet) => snippet.id !== snippetId);
          return true;
        }
        return false;
      }),
    fail: (workosUserId, attemptId, message) =>
      Effect.sync(() => {
        if (cleanup?.workosUserId === workosUserId && cleanup.attemptId === attemptId) {
          cleanup = {
            ...cleanup,
            attemptId: null,
            lastFailure: message,
            leaseExpiresAt: null,
          };
        }
      }),
    get: (workosUserId, storageProvider) =>
      Effect.sync(() => {
        const active = cleanup?.workosUserId === workosUserId ? cleanup : null;
        return {
          affectedSnippetCount:
            active === null
              ? snippets.filter((snippet) => snippet.storageProvider === storageProvider).length
              : active.totalSnippetCount,
          cleanup: active,
          remainingSnippetCount:
            active === null
              ? 0
              : snippets.filter((snippet) => snippet.storageProvider === active.storageProvider)
                  .length,
        };
      }),
    isActive: (workosUserId) => Effect.succeed(cleanup?.workosUserId === workosUserId),
    readyToDisconnect: (workosUserId, attemptId) =>
      Effect.succeed(
        cleanup?.workosUserId === workosUserId &&
          cleanup.attemptId === attemptId &&
          snippets.length === 0,
      ),
    reserveAuthorization: (_, storageProvider) =>
      Effect.sync(() => {
        if (cleanup !== null) return null;
        authorization ??= storageProvider;
        return authorization;
      }),
  });

  return {
    cleanup: () => cleanup,
    layer: Layer.succeed(StorageLifecycleStore, service),
    service,
    snippets: () => snippets,
    supersede: () => {
      if (cleanup !== null) cleanup = { ...cleanup, attemptId: "superseding-attempt" };
    },
  };
};

const makeStorage = (options?: {
  readonly deleteFailureFor?: string;
  readonly linkedProvider?: StorageProviderName | null;
  readonly onDelete?: () => void;
  readonly status?: "CONNECTED" | "NEEDS_REAUTHORIZATION" | "NOT_CONNECTED";
}) => {
  const events: Array<string> = [];
  const service = StorageProvider.of({
    beginAuthorization: () => Effect.succeed({ url: "https://workos.example/authorize" }),
    deleteObject: (input) => {
      events.push(`provider:${input.storageObjectId}`);
      options?.onDelete?.();
      return input.storageObjectId === options?.deleteFailureFor
        ? Effect.fail(
            new StorageProviderError({
              message: "controlled provider deletion failure",
              storageProvider: input.storageProvider,
            }),
          )
        : Effect.void;
    },
    disconnect: () =>
      Effect.sync(() => {
        events.push("credential:disconnect");
      }),
    downloadObject: () => Effect.succeed(new Uint8Array()),
    ensureConnected: () => Effect.void,
    getDestinationUrl: () => Effect.succeed("https://drive.example/folder"),
    getDownloadTarget: () => Effect.succeed({ url: "https://download.example", headers: [] }),
    getDownloadUrl: () => Effect.succeed("https://download.example"),
    getLinkedProvider: () =>
      Effect.succeed(
        options !== undefined && "linkedProvider" in options
          ? (options.linkedProvider ?? null)
          : provider,
      ),
    getStatus: () => {
      const status = options?.status ?? "CONNECTED";
      return Effect.succeed(
        status === "CONNECTED"
          ? ({
              externalDestinationUrl: "https://drive.example/folder",
              status,
              storageProvider: provider,
            } satisfies StorageProviderStatus)
          : ({
              externalDestinationUrl: null,
              status,
              storageProvider: provider,
            } satisfies StorageProviderStatus),
      );
    },
    prepareUpload: () =>
      Effect.succeed({
        expiresAt: null,
        storageObjectId: null,
        storageProvider: provider,
        upload: {
          headers: [],
          method: "PUT",
          strategy: { type: "single_request" },
          url: "https://upload.example",
        },
      }),
  });
  return { events, layer: Layer.succeed(StorageProvider, service), service };
};

const run = <A, E>(
  effect: Effect.Effect<A, E, StorageLifecycle>,
  store: ReturnType<typeof makeStore>,
  storage: ReturnType<typeof makeStorage>,
) =>
  Effect.runPromise(
    effect.pipe(
      Effect.provide(
        StorageLifecycle.layer.pipe(Layer.provide(store.layer), Layer.provide(storage.layer)),
      ),
    ),
  );

describe("storage destructive lifecycle", () => {
  it("deletes provider content before each authoritative row and disconnects last", async () => {
    const store = makeStore(["first", "second"]);
    const storage = makeStorage();

    const result = await run(
      Effect.flatMap(StorageLifecycle, (lifecycle) =>
        lifecycle.beginCleanup({
          action: "UNLINK",
          expectedSnippetCount: 2,
          storageProvider: provider,
          workosUserId: owner,
        }),
      ),
      store,
      storage,
    );

    expect(result).toEqual({ action: "UNLINK", outcome: "COMPLETED" });
    expect(storage.events).toEqual([
      "provider:object-first",
      "provider:object-second",
      "credential:disconnect",
    ]);
    expect(store.snippets()).toEqual([]);
    expect(store.cleanup()).toBeNull();
  });

  it("retains the credential and completed deletions after a partial failure, then retries", async () => {
    const store = makeStore(["first", "second", "third"]);
    const failingStorage = makeStorage({ deleteFailureFor: "object-second" });

    const partial = await run(
      Effect.flatMap(StorageLifecycle, (lifecycle) =>
        lifecycle.beginCleanup({
          action: "SWITCH",
          expectedSnippetCount: 3,
          storageProvider: provider,
          workosUserId: owner,
        }),
      ),
      store,
      failingStorage,
    );

    expect(partial).toMatchObject({
      outcome: "PARTIAL",
      progress: {
        action: "SWITCH",
        remainingSnippetCount: 2,
        totalSnippetCount: 3,
      },
    });
    expect(store.snippets().map(({ id }) => id)).toEqual(["second", "third"]);
    expect(failingStorage.events).not.toContain("credential:disconnect");

    const recoveredStorage = makeStorage();
    const completed = await run(
      Effect.flatMap(StorageLifecycle, (lifecycle) => lifecycle.retryCleanup(owner, provider)),
      store,
      recoveredStorage,
    );

    expect(completed).toEqual({ action: "SWITCH", outcome: "COMPLETED" });
    expect(recoveredStorage.events.at(-1)).toBe("credential:disconnect");
  });

  it("rejects a stale exact count without beginning cleanup", async () => {
    const store = makeStore(["first", "second"]);
    const storage = makeStorage();

    const exit = await run(
      Effect.flatMap(StorageLifecycle, (lifecycle) =>
        lifecycle
          .beginCleanup({
            action: "UNLINK",
            expectedSnippetCount: 1,
            storageProvider: provider,
            workosUserId: owner,
          })
          .pipe(Effect.result),
      ),
      store,
      storage,
    );

    expect(exit).toMatchObject({ _tag: "Failure", failure: { code: "CONFLICT" } });
    expect(store.cleanup()).toBeNull();
    expect(storage.events).toEqual([]);
  });

  it("allows same-provider reauthorization but rejects a second provider and cleanup-time commands", async () => {
    const store = makeStore(["first"]);
    const storage = makeStorage();
    const begin = vi.fn(() => Effect.succeed({ url: "https://workos.example/authorize" }));
    const storageWithBegin = {
      ...storage,
      layer: Layer.succeed(
        StorageProvider,
        StorageProvider.of({
          ...storage.service,
          beginAuthorization: begin,
        }),
      ),
    };

    await run(
      Effect.flatMap(StorageLifecycle, (lifecycle) =>
        lifecycle.beginAuthorization(owner, provider, "https://app.plakk.io/storage"),
      ),
      store,
      storageWithBegin,
    );
    expect(begin).toHaveBeenCalled();

    const wrongProvider = await run(
      Effect.flatMap(StorageLifecycle, (lifecycle) =>
        lifecycle
          .beginAuthorization(owner, "DROPBOX", "https://app.plakk.io/storage")
          .pipe(Effect.result),
      ),
      store,
      storageWithBegin,
    );
    expect(wrongProvider).toMatchObject({
      _tag: "Failure",
      failure: { code: "CONFLICT" },
    });

    await Effect.runPromise(
      store.service.begin({
        action: "UNLINK",
        expectedSnippetCount: 1,
        storageProvider: provider,
        workosUserId: owner,
      }),
    );
    const lateCommand = await run(
      Effect.flatMap(StorageLifecycle, (lifecycle) =>
        lifecycle.assertCommandsAllowed(owner).pipe(Effect.result),
      ),
      store,
      storageWithBegin,
    );
    expect(lateCommand).toMatchObject({
      _tag: "Failure",
      failure: { code: "CONFLICT" },
    });
  });

  it("reserves one first-link provider across concurrent authorization attempts", async () => {
    const store = makeStore([]);
    const storage = makeStorage({ linkedProvider: null });

    await run(
      Effect.flatMap(StorageLifecycle, (lifecycle) =>
        lifecycle.beginAuthorization(owner, provider, "https://app.plakk.io/storage"),
      ),
      store,
      storage,
    );
    const differentProvider = await run(
      Effect.flatMap(StorageLifecycle, (lifecycle) =>
        lifecycle
          .beginAuthorization(owner, "DROPBOX", "https://app.plakk.io/storage")
          .pipe(Effect.result),
      ),
      store,
      storage,
    );

    expect(differentProvider).toMatchObject({
      _tag: "Failure",
      failure: { code: "CONFLICT" },
    });
  });

  it("releases a first-link reservation after an unconfirmed provider return", async () => {
    const store = makeStore([]);
    const storage = makeStorage({ linkedProvider: null, status: "NOT_CONNECTED" });

    await run(
      Effect.flatMap(StorageLifecycle, (lifecycle) =>
        lifecycle.beginAuthorization(owner, provider, "https://app.plakk.io/storage"),
      ),
      store,
      storage,
    );
    await run(
      Effect.flatMap(StorageLifecycle, (lifecycle) => lifecycle.getProviderStatus(owner, provider)),
      store,
      storage,
    );
    const replacement = await run(
      Effect.flatMap(StorageLifecycle, (lifecycle) =>
        lifecycle.beginAuthorization(owner, "DROPBOX", "https://app.plakk.io/storage"),
      ),
      store,
      storage,
    );

    expect(replacement.url).toContain("workos.example");
  });

  it("does not disconnect or report success after another Retry steals the lease", async () => {
    const store = makeStore(["first"]);
    const storage = makeStorage({ onDelete: store.supersede });

    const result = await run(
      Effect.flatMap(StorageLifecycle, (lifecycle) =>
        lifecycle
          .beginCleanup({
            action: "UNLINK",
            expectedSnippetCount: 1,
            storageProvider: provider,
            workosUserId: owner,
          })
          .pipe(Effect.result),
      ),
      store,
      storage,
    );

    expect(result).toMatchObject({
      _tag: "Failure",
      failure: { code: "CONFLICT" },
    });
    expect(store.snippets()).toHaveLength(1);
    expect(storage.events).not.toContain("credential:disconnect");
  });
});
