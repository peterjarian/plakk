import type { DrizzleService } from "@plakk/db";
import { snippetChangeFeeds, snippetChanges, snippets, type SnippetRow } from "@plakk/db/schema";
import { CurrentUser } from "@plakk/shared/PlakkApi";
import { describe, expect, it, vi } from "vite-plus/test";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import { type StorageProviderService } from "./storage/StorageProvider.ts";
import { StorageProviderError } from "./storage/types.ts";
import {
  acquireSnippetUploadLease,
  confirmTextSnippetUpload,
  decideUploadLease,
  getSnippetCopyPayload,
  insertSnippet,
  prepareSnippetUpload,
  updateStoredSnippetUpload,
} from "./PlakkApiLive.ts";

class ChangeInsertError extends Schema.TaggedErrorClass<ChangeInsertError>()(
  "ChangeInsertError",
  {},
) {}

const row = (overrides: Partial<SnippetRow> = {}): SnippetRow => ({
  id: "0d1e2f3a-4567-4890-8abc-def012345678",
  ownerWorkosUserId: "user-1",
  kind: "TEXT",
  title: "Text snippet",
  storageProvider: "GOOGLE_DRIVE",
  storageObjectId: "drive-id",
  clientMutationId: null,
  uploadStatus: "READY",
  uploadLeaseId: null,
  uploadLeaseExpiresAt: null,
  uploadPreparationGeneration: null,
  uploadPreparation: null,
  uploadFailureMessage: null,
  fileName: "0d1e2f3a-4567-4890-8abc-def012345678.txt",
  byteSize: 12,
  contentType: "text/plain; charset=utf-8",
  deletedAt: null,
  createdAt: DateTime.toDateUtc(DateTime.makeUnsafe("2026-07-10T20:00:00Z")),
  updatedAt: DateTime.toDateUtc(DateTime.makeUnsafe("2026-07-10T20:00:00Z")),
  ...overrides,
});

describe("upload lease decisions", () => {
  const mutationId = "1d1e2f3a-4567-4890-8abc-def012345678";
  const otherMutationId = "2d1e2f3a-4567-4890-8abc-def012345678";
  const now = DateTime.toDateUtc(DateTime.makeUnsafe("2026-07-15T08:00:00Z"));

  it("renews the source device lease idempotently", () => {
    expect(
      decideUploadLease(
        row({
          uploadStatus: "UPLOADING",
          clientMutationId: mutationId,
          uploadLeaseId: mutationId,
          uploadLeaseExpiresAt: DateTime.toDateUtc(
            DateTime.addDuration(DateTime.makeUnsafe(now), 30_000),
          ),
        }),
        mutationId,
        now,
      ),
    ).toBe("RENEW");
  });

  it("interrupts an expired lease before the source reacquires it", () => {
    expect(
      decideUploadLease(
        row({
          uploadStatus: "UPLOADING",
          clientMutationId: mutationId,
          uploadLeaseId: mutationId,
          uploadLeaseExpiresAt: DateTime.toDateUtc(
            DateTime.addDuration(DateTime.makeUnsafe(now), -1),
          ),
        }),
        mutationId,
        now,
      ),
    ).toBe("INTERRUPT_AND_REACQUIRE");
  });

  it("does not let another mutation steal an active lease", () => {
    expect(
      decideUploadLease(
        row({
          uploadStatus: "UPLOADING",
          clientMutationId: mutationId,
          uploadLeaseId: mutationId,
          uploadLeaseExpiresAt: DateTime.toDateUtc(
            DateTime.addDuration(DateTime.makeUnsafe(now), 30_000),
          ),
        }),
        otherMutationId,
        now,
      ),
    ).toBe("NOT_OWNER");
  });
});

const queryDb = (rows: ReadonlyArray<SnippetRow>) =>
  ({
    select: () => ({
      from: () => ({
        where: () => ({
          limit: () => ({ pipe: () => Effect.succeed(rows) }),
        }),
      }),
    }),
  }) as unknown as DrizzleService["db"];

const statefulDb = (initial: SnippetRow, stale = false, failChange = false) => {
  let stored = initial;
  let updateCount = 0;
  let latestSequence = 0n;
  const persistedChanges: Array<Record<string, unknown>> = [];
  const db = {
    transaction: <A, E, R>(
      body: (tx: DrizzleService["db"]) => Effect.Effect<A, E, R>,
    ): Effect.Effect<A, E, R> => {
      const before = stored;
      const changesBefore = persistedChanges.length;
      return body(db as unknown as DrizzleService["db"]).pipe(
        Effect.tapCause(() =>
          Effect.sync(() => {
            stored = before;
            persistedChanges.length = changesBefore;
          }),
        ),
      );
    },
    select: () => ({
      from: () => ({
        where: () => ({
          limit: () => ({ pipe: () => Effect.succeed([stored]) }),
        }),
      }),
    }),
    update: () => ({
      set: (values: Partial<SnippetRow>) => ({
        where: () => ({
          returning: () =>
            Effect.sync(() => {
              updateCount += 1;
              if (stale) return [];
              stored = { ...stored, ...values };
              return [stored];
            }),
        }),
      }),
    }),
    insert: (table: unknown) => ({
      values: (values: Record<string, unknown>) => {
        if (table === snippetChangeFeeds) {
          return {
            onConflictDoUpdate: () => ({
              returning: () => Effect.sync(() => [{ latestSequence: (latestSequence += 1n) }]),
            }),
          };
        }
        if (table === snippetChanges) {
          return failChange
            ? Effect.fail(new ChangeInsertError())
            : Effect.sync(() => void persistedChanges.push(values));
        }
        throw new Error("Unexpected insert table");
      },
    }),
    delete: () => ({ where: () => Effect.void }),
  } as unknown as DrizzleService["db"];
  return {
    db,
    stored: () => stored,
    updateCount: () => updateCount,
    persistedChanges: () => persistedChanges,
  };
};

describe("upload lease persistence", () => {
  it("publishes interruption before reacquiring an expired lease", async () => {
    const mutationId = "1d1e2f3a-4567-4890-8abc-def012345678";
    const expired = row({
      uploadStatus: "UPLOADING",
      clientMutationId: mutationId,
      uploadLeaseId: mutationId,
      uploadLeaseExpiresAt: DateTime.toDateUtc(DateTime.makeUnsafe(0)),
    });
    const state = statefulDb(expired);

    const leaseExpiresAt = await Effect.runPromise(
      acquireSnippetUploadLease({ db: state.db }, "user-1", expired, mutationId),
    );

    expect(Date.parse(leaseExpiresAt)).toBeGreaterThan(
      DateTime.toEpochMillis(DateTime.nowUnsafe()),
    );
    expect(state.stored()).toMatchObject({
      uploadStatus: "UPLOADING",
      uploadLeaseId: mutationId,
    });
    expect(state.persistedChanges()).toHaveLength(2);
  });
});

describe("text snippet persistence and authorization", () => {
  it("persists metadata only in UPLOADING state", async () => {
    const mutationId = "1d1e2f3a-4567-4890-8abc-def012345678";
    let inserted: Record<string, unknown> | undefined;
    let latestSequence = 0n;
    const stored = row({
      uploadStatus: "UPLOADING",
      storageObjectId: null,
      clientMutationId: mutationId,
    });
    const db = {
      transaction: <A, E, R>(
        body: (tx: DrizzleService["db"]) => Effect.Effect<A, E, R>,
      ): Effect.Effect<A, E, R> => body(db as unknown as DrizzleService["db"]),
      delete: () => ({ where: () => Effect.void }),
      insert: (table: unknown) => ({
        values: (values: Record<string, unknown>) => {
          if (table === snippets) {
            inserted = values;
            return {
              onConflictDoNothing: () => ({ returning: () => Effect.succeed([stored]) }),
            };
          }
          if (table === snippetChangeFeeds) {
            return {
              onConflictDoUpdate: () => ({
                returning: () => Effect.sync(() => [{ latestSequence: (latestSequence += 1n) }]),
              }),
            };
          }
          if (table === snippetChanges) return Effect.void;
          throw new Error("Unexpected insert table");
        },
      }),
    } as unknown as DrizzleService["db"];
    const drizzle = {
      db,
    } satisfies DrizzleService;

    await Effect.runPromise(
      insertSnippet(drizzle, {
        id: stored.id,
        kind: "TEXT",
        title: "Text snippet",
        fileName: stored.fileName,
        byteSize: stored.byteSize,
        contentType: "text/plain; charset=utf-8",
        storageProvider: "GOOGLE_DRIVE",
        storageObjectId: null,
        clientMutationId: mutationId,
      }).pipe(
        Effect.provideService(CurrentUser, {
          id: "user-1",
          email: "user@example.com",
          firstName: null,
          lastName: null,
          createdAt: null,
          updatedAt: null,
        }),
      ),
    );

    expect(inserted).toMatchObject({
      id: stored.id,
      kind: "TEXT",
      title: "Text snippet",
      fileName: stored.fileName,
      byteSize: stored.byteSize,
      contentType: "text/plain; charset=utf-8",
      storageProvider: "GOOGLE_DRIVE",
      storageObjectId: null,
      clientMutationId: mutationId,
      uploadLeaseId: mutationId,
      ownerWorkosUserId: "user-1",
      uploadStatus: "UPLOADING",
    });
    expect(inserted?.uploadLeaseExpiresAt).toBeInstanceOf(Date);
  });

  it("returns the existing metadata when the same create mutation is replayed", async () => {
    const mutationId = "1d1e2f3a-4567-4890-8abc-def012345678";
    const existing = row({
      uploadStatus: "UPLOADING",
      storageObjectId: null,
      clientMutationId: mutationId,
    });
    const db = {
      transaction: <A, E, R>(
        body: (tx: DrizzleService["db"]) => Effect.Effect<A, E, R>,
      ): Effect.Effect<A, E, R> => body(db as unknown as DrizzleService["db"]),
      insert: (table: unknown) => {
        if (table !== snippets) throw new Error("Unexpected insert table");
        return {
          values: () => ({
            onConflictDoNothing: () => ({ returning: () => Effect.succeed([]) }),
          }),
        };
      },
      select: () => ({
        from: () => ({
          where: () => ({
            limit: () => ({ pipe: () => Effect.succeed([existing]) }),
          }),
        }),
      }),
    } as unknown as DrizzleService["db"];

    const result = await Effect.runPromise(
      insertSnippet(
        { db },
        {
          id: existing.id,
          kind: "TEXT",
          title: existing.title,
          fileName: existing.fileName,
          byteSize: existing.byteSize,
          contentType: existing.contentType,
          storageProvider: "GOOGLE_DRIVE",
          storageObjectId: null,
          clientMutationId: mutationId,
        },
      ).pipe(Effect.provideService(CurrentUser, { id: "user-1" } as never)),
    );

    expect(result).toMatchObject({ id: existing.id, uploadStatus: "UPLOADING" });
  });
});

describe("stored snippet content payloads", () => {
  it("returns an owned ready text snippet download target", async () => {
    const stored = row({ kind: "TEXT" });
    const download = { url: "https://www.googleapis.com/download", headers: [] };
    const getDownloadTarget = vi.fn(() => Effect.succeed(download));
    const storage = { getDownloadTarget } as unknown as StorageProviderService["Service"];

    const result = await Effect.runPromise(
      getSnippetCopyPayload({ db: queryDb([stored]) }, storage, "user-1", stored.id),
    );

    expect(result).toMatchObject({ kind: "TEXT", download });
    expect(getDownloadTarget).toHaveBeenCalledWith({
      storageProvider: "GOOGLE_DRIVE",
      storageObjectId: "drive-id",
      workosUserId: "user-1",
    });
  });
});

describe("text upload finalization authorization", () => {
  it("confirms the exact owned legacy object before returning its provider", async () => {
    const legacy = row({ storageProvider: null, storageObjectId: null });
    const bytes = new TextEncoder().encode(legacy.title);
    const downloadObject = vi.fn(() => Effect.succeed(bytes));
    const storage = { downloadObject } as unknown as StorageProviderService["Service"];

    await expect(
      Effect.runPromise(
        confirmTextSnippetUpload(storage, legacy, "user-1", {
          storageProvider: "DROPBOX",
          storageObjectId: "/snippet/text.txt",
        }),
      ),
    ).resolves.toBe("DROPBOX");
    expect(downloadObject).toHaveBeenCalledWith({
      storageProvider: "DROPBOX",
      storageObjectId: "/snippet/text.txt",
      expectedByteSize: legacy.byteSize,
      workosUserId: "user-1",
    });
  });

  it("rejects another owner's row and provider mismatches without resolving content", async () => {
    const downloadObject = vi.fn();
    const storage = { downloadObject } as unknown as StorageProviderService["Service"];
    const pending = row({ uploadStatus: "UPLOADING" });

    const [wrongOwner, wrongProvider] = await Promise.all([
      Effect.runPromise(
        Effect.flip(
          confirmTextSnippetUpload(storage, pending, "user-2", {
            storageObjectId: "drive-id",
          }),
        ),
      ),
      Effect.runPromise(
        Effect.flip(
          confirmTextSnippetUpload(storage, pending, "user-1", {
            storageProvider: "DROPBOX",
            storageObjectId: "/wrong-provider.txt",
          }),
        ),
      ),
    ]);

    expect(wrongOwner).toMatchObject({ code: "NOT_FOUND" });
    expect(wrongProvider).toMatchObject({ code: "NOT_FOUND" });
    expect(downloadObject).not.toHaveBeenCalled();
  });

  it("preserves the legacy title when provider confirmation fails", async () => {
    const legacy = row({
      title: "durable legacy body",
      storageProvider: null,
      storageObjectId: null,
    });
    const storage = {
      downloadObject: () =>
        Effect.fail(
          new StorageProviderError({
            storageProvider: "GOOGLE_DRIVE",
            message: "Provider unavailable.",
          }),
        ),
    } as unknown as StorageProviderService["Service"];

    const failure = await Effect.runPromise(
      Effect.flip(
        confirmTextSnippetUpload(storage, legacy, "user-1", {
          storageProvider: "GOOGLE_DRIVE",
          storageObjectId: "drive-id",
        }),
      ),
    );

    expect(failure).toMatchObject({ code: "INTERNAL_SERVER_ERROR" });
    expect(legacy.title).toBe("durable legacy body");
  });
});

describe("prepared upload authorization", () => {
  const prepared = {
    storageProvider: "GOOGLE_DRIVE" as const,
    storageObjectId: null,
    upload: {
      method: "PUT" as const,
      url: "https://upload.example",
      headers: [],
      strategy: { type: "single_request" as const },
    },
    expiresAt: null,
  };

  it("derives text upload metadata from the owned row", async () => {
    const pending = row({ uploadStatus: "UPLOADING" });
    const prepareUpload = vi.fn(() => Effect.succeed(prepared));
    const storage = { prepareUpload } as unknown as StorageProviderService["Service"];

    await Effect.runPromise(
      prepareSnippetUpload({ db: queryDb([pending]) }, storage, "user-1", {
        snippetId: pending.id,
        storageProvider: "GOOGLE_DRIVE",
      }),
    );

    expect(prepareUpload).toHaveBeenCalledWith({
      snippetId: pending.id,
      storageProvider: "GOOGLE_DRIVE",
      fileName: `${pending.id}.txt`,
      byteSize: pending.byteSize,
      contentType: "text/plain; charset=utf-8",
      workosUserId: "user-1",
    });
  });

  it("reuses the prepared provider session for the same durable mutation", async () => {
    const mutationId = "1d1e2f3a-4567-4890-8abc-def012345678";
    const preparationGeneration = 1;
    const pending = row({
      uploadStatus: "UPLOADING",
      clientMutationId: mutationId,
      uploadLeaseId: mutationId,
      uploadLeaseExpiresAt: DateTime.toDateUtc(DateTime.addDuration(DateTime.nowUnsafe(), 30_000)),
      uploadPreparation: prepared,
      uploadPreparationGeneration: preparationGeneration,
    });
    const state = statefulDb(pending);
    const prepareUpload = vi.fn();
    const storage = { prepareUpload } as unknown as StorageProviderService["Service"];

    const replayed = await Effect.runPromise(
      prepareSnippetUpload({ db: state.db }, storage, "user-1", {
        snippetId: pending.id,
        storageProvider: "GOOGLE_DRIVE",
        mutationId,
      }),
    );

    expect(replayed).toMatchObject(prepared);
    expect(replayed.leaseExpiresAt).toEqual(expect.any(String));
    expect(replayed.resume).toBe(true);
    expect(replayed.preparationGeneration).toBe(preparationGeneration);
    expect(prepareUpload).not.toHaveBeenCalled();
  });

  it("replaces a stale prepared session without turning it into a failure", async () => {
    const mutationId = "1d1e2f3a-4567-4890-8abc-def012345678";
    const stalePreparationGeneration = 1;
    const stalePreparation = { ...prepared, upload: { ...prepared.upload, url: "stale" } };
    const pending = row({
      uploadStatus: "UPLOADING",
      clientMutationId: mutationId,
      uploadLeaseId: mutationId,
      uploadLeaseExpiresAt: DateTime.toDateUtc(DateTime.addDuration(DateTime.nowUnsafe(), 30_000)),
      uploadPreparation: stalePreparation,
      uploadPreparationGeneration: stalePreparationGeneration,
    });
    const state = statefulDb(pending);
    const prepareUpload = vi.fn(() => Effect.succeed(prepared));
    const storage = { prepareUpload } as unknown as StorageProviderService["Service"];

    const refreshed = await Effect.runPromise(
      prepareSnippetUpload({ db: state.db }, storage, "user-1", {
        snippetId: pending.id,
        storageProvider: "GOOGLE_DRIVE",
        mutationId,
        replacePreparationGeneration: stalePreparationGeneration,
      }),
    );

    const replayed = await Effect.runPromise(
      prepareSnippetUpload({ db: state.db }, storage, "user-1", {
        snippetId: pending.id,
        storageProvider: "GOOGLE_DRIVE",
        mutationId,
        replacePreparationGeneration: stalePreparationGeneration,
      }),
    );

    expect(refreshed).toMatchObject(prepared);
    expect(prepareUpload).toHaveBeenCalledOnce();
    expect(state.stored().uploadPreparation).toEqual(prepared);
    expect(refreshed.preparationGeneration).toBe(2);
    expect(replayed.preparationGeneration).toBe(refreshed.preparationGeneration);
    expect(replayed.resume).toBe(true);
  });

  it("rejects another owner's row and a provider that differs from pending metadata", async () => {
    const pending = row({ uploadStatus: "UPLOADING" });
    const prepareUpload = vi.fn();
    const storage = { prepareUpload } as unknown as StorageProviderService["Service"];

    const [wrongOwner, wrongProvider] = await Promise.all([
      Effect.runPromise(
        Effect.flip(
          prepareSnippetUpload({ db: queryDb([pending]) }, storage, "user-2", {
            snippetId: pending.id,
            storageProvider: "GOOGLE_DRIVE",
          }),
        ),
      ),
      Effect.runPromise(
        Effect.flip(
          prepareSnippetUpload({ db: queryDb([pending]) }, storage, "user-1", {
            snippetId: pending.id,
            storageProvider: "DROPBOX",
          }),
        ),
      ),
    ]);

    expect(wrongOwner).toMatchObject({ code: "NOT_FOUND" });
    expect(wrongProvider).toMatchObject({ code: "NOT_FOUND" });
    expect(prepareUpload).not.toHaveBeenCalled();
  });
});

describe("stored text finalization persistence", () => {
  it("returns an already finalized durable mutation idempotently", async () => {
    const mutationId = "1d1e2f3a-4567-4890-8abc-def012345678";
    const ready = row({ clientMutationId: mutationId });
    const state = statefulDb(ready);
    const storage = {
      getDownloadUrl: () => Effect.succeed("https://storage.example/signed"),
    } as unknown as StorageProviderService["Service"];

    const result = await Effect.runPromise(
      updateStoredSnippetUpload({ db: state.db }, storage, "user-1", {
        id: ready.id,
        uploadStatus: "READY",
        mutationId,
        storageObjectId: ready.storageObjectId!,
      }),
    );

    expect(result).toMatchObject({ uploadStatus: "READY" });
    expect(state.updateCount()).toBe(0);
  });

  it("rejects completion after the durable upload lease expires", async () => {
    const mutationId = "1d1e2f3a-4567-4890-8abc-def012345678";
    const expired = row({
      uploadStatus: "UPLOADING",
      clientMutationId: mutationId,
      uploadLeaseId: mutationId,
      uploadLeaseExpiresAt: DateTime.toDateUtc(DateTime.makeUnsafe(0)),
    });
    const state = statefulDb(expired);
    const downloadObject = vi.fn();
    const storage = { downloadObject } as unknown as StorageProviderService["Service"];

    const failure = await Effect.runPromise(
      Effect.flip(
        updateStoredSnippetUpload({ db: state.db }, storage, "user-1", {
          id: expired.id,
          uploadStatus: "READY",
          mutationId,
          storageObjectId: "drive-id",
        }),
      ),
    );

    expect(failure).toMatchObject({ code: "CONFLICT", message: "Upload lease expired." });
    expect(state.stored().uploadStatus).toBe("INTERRUPTED");
    expect(downloadObject).not.toHaveBeenCalled();
  });

  it("publishes interrupted and resumed upload states", async () => {
    const pending = row({ uploadStatus: "UPLOADING" });
    const state = statefulDb(pending);
    const storage = {} as StorageProviderService["Service"];

    await Effect.runPromise(
      updateStoredSnippetUpload({ db: state.db }, storage, "user-1", {
        id: pending.id,
        uploadStatus: "INTERRUPTED",
      }),
    );
    await Effect.runPromise(
      updateStoredSnippetUpload({ db: state.db }, storage, "user-1", {
        id: pending.id,
        uploadStatus: "UPLOADING",
      }),
    );

    expect(state.persistedChanges()).toMatchObject([
      { snapshot: { uploadStatus: "INTERRUPTED" } },
      { snapshot: { uploadStatus: "UPLOADING" } },
    ]);
  });

  it("atomically replaces a legacy body only after exact provider confirmation", async () => {
    const body = "legacy 👋";
    const bytes = new TextEncoder().encode(body);
    const legacy = row({
      title: body,
      byteSize: bytes.byteLength,
      storageProvider: null,
      storageObjectId: null,
    });
    const state = statefulDb(legacy);
    const storage = {
      downloadObject: () => Effect.succeed(bytes),
      getDownloadUrl: () => Effect.succeed("https://storage.example/signed"),
    } as unknown as StorageProviderService["Service"];

    const result = await Effect.runPromise(
      updateStoredSnippetUpload({ db: state.db }, storage, "user-1", {
        id: legacy.id,
        uploadStatus: "READY",
        storageProvider: "DROPBOX",
        storageObjectId: "/snippet/text.txt",
      }),
    );

    expect(state.stored()).toMatchObject({
      title: "Text snippet",
      storageProvider: "DROPBOX",
      storageObjectId: "/snippet/text.txt",
      uploadStatus: "READY",
    });
    expect(state.updateCount()).toBe(1);
    expect(result).toMatchObject({
      contentUrl: "https://storage.example/signed",
      thumbnailUrl: null,
      textContent: null,
    });
  });

  it("keeps a finalized snippet ready when download URL generation fails", async () => {
    const pending = row({ uploadStatus: "UPLOADING" });
    const state = statefulDb(pending);
    const storage = {
      downloadObject: () => Effect.succeed(new Uint8Array(pending.byteSize)),
      getDownloadUrl: () =>
        Effect.fail(
          new StorageProviderError({
            storageProvider: "GOOGLE_DRIVE",
            message: "Provider unavailable.",
          }),
        ),
    } as unknown as StorageProviderService["Service"];

    await expect(
      Effect.runPromise(
        updateStoredSnippetUpload({ db: state.db }, storage, "user-1", {
          id: pending.id,
          uploadStatus: "READY",
          storageObjectId: "drive-id",
        }),
      ),
    ).resolves.toMatchObject({ uploadStatus: "READY", contentUrl: null });
    expect(state.stored().uploadStatus).toBe("READY");
  });

  it("preserves legacy persistence when same-size provider bytes are wrong", async () => {
    const legacy = row({
      title: "abc",
      byteSize: 3,
      storageProvider: null,
      storageObjectId: null,
    });
    const state = statefulDb(legacy);
    const storage = {
      downloadObject: () => Effect.succeed(new TextEncoder().encode("xyz")),
    } as unknown as StorageProviderService["Service"];

    const failure = await Effect.runPromise(
      Effect.flip(
        updateStoredSnippetUpload({ db: state.db }, storage, "user-1", {
          id: legacy.id,
          uploadStatus: "READY",
          storageProvider: "GOOGLE_DRIVE",
          storageObjectId: "wrong-object",
        }),
      ),
    );

    expect(failure).toMatchObject({
      code: "INTERNAL_SERVER_ERROR",
      message: "Uploaded object does not match the legacy snippet body.",
    });
    expect(state.stored()).toEqual(legacy);
    expect(state.updateCount()).toBe(0);
  });

  it.each([
    row({ ownerWorkosUserId: "user-2", storageProvider: null, storageObjectId: null }),
    row({ deletedAt: DateTime.toDateUtc(DateTime.makeUnsafe("2026-07-10T21:00:00Z")) }),
    row(),
  ])("does not update an unauthorized, deleted, or noneligible row", async (ineligible) => {
    const state = statefulDb(ineligible);
    const downloadObject = vi.fn();
    const storage = { downloadObject } as unknown as StorageProviderService["Service"];

    const failure = await Effect.runPromise(
      Effect.flip(
        updateStoredSnippetUpload({ db: state.db }, storage, "user-1", {
          id: ineligible.id,
          uploadStatus: "READY",
          storageObjectId: "object-id",
        }),
      ),
    );

    expect(failure).toMatchObject({ code: "NOT_FOUND" });
    expect(state.updateCount()).toBe(0);
    expect(downloadObject).not.toHaveBeenCalled();
  });

  it("does not overwrite a concurrently changed row", async () => {
    const body = "legacy";
    const bytes = new TextEncoder().encode(body);
    const legacy = row({
      title: body,
      byteSize: bytes.byteLength,
      storageProvider: null,
      storageObjectId: null,
    });
    const state = statefulDb(legacy, true);
    const storage = {
      downloadObject: () => Effect.succeed(bytes),
    } as unknown as StorageProviderService["Service"];

    const failure = await Effect.runPromise(
      Effect.flip(
        updateStoredSnippetUpload({ db: state.db }, storage, "user-1", {
          id: legacy.id,
          uploadStatus: "READY",
          storageProvider: "ONE_DRIVE",
          storageObjectId: "one-id",
        }),
      ),
    );

    expect(failure).toMatchObject({ code: "NOT_FOUND" });
    expect(state.stored()).toEqual(legacy);
    expect(state.updateCount()).toBe(1);
  });

  it("rolls back the status change when its durable change cannot be appended", async () => {
    const pending = row({ uploadStatus: "UPLOADING" });
    const state = statefulDb(pending, false, true);
    const storage = {
      downloadObject: () => Effect.succeed(new Uint8Array(pending.byteSize)),
    } as unknown as StorageProviderService["Service"];

    await expect(
      Effect.runPromise(
        updateStoredSnippetUpload({ db: state.db }, storage, "user-1", {
          id: pending.id,
          uploadStatus: "FAILED",
        }),
      ),
    ).rejects.toThrow();

    expect(state.stored()).toEqual(pending);
    expect(state.persistedChanges()).toEqual([]);
  });
});
