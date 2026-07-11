import type { DrizzleService } from "@plakk/db";
import type { SnippetRow } from "@plakk/db/schema";
import { CurrentUser } from "@plakk/shared/PlakkApi";
import { describe, expect, it, vi } from "vite-plus/test";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";

import { type StorageProviderService } from "./storage/StorageProvider.ts";
import { StorageProviderError } from "./storage/types.ts";
import {
  confirmTextSnippetUpload,
  insertSnippet,
  prepareSnippetUpload,
  updateStoredSnippetUpload,
} from "./PlakkApiLive.ts";

const row = (overrides: Partial<SnippetRow> = {}): SnippetRow => ({
  id: "0d1e2f3a-4567-4890-8abc-def012345678",
  ownerWorkosUserId: "user-1",
  kind: "TEXT",
  title: "Text snippet",
  storageProvider: "GOOGLE_DRIVE",
  storageObjectId: "drive-id",
  uploadStatus: "READY",
  fileName: "0d1e2f3a-4567-4890-8abc-def012345678.txt",
  byteSize: 12,
  contentType: "text/plain; charset=utf-8",
  deletedAt: null,
  createdAt: DateTime.toDateUtc(DateTime.makeUnsafe("2026-07-10T20:00:00Z")),
  updatedAt: DateTime.toDateUtc(DateTime.makeUnsafe("2026-07-10T20:00:00Z")),
  ...overrides,
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

const statefulDb = (initial: SnippetRow, stale = false) => {
  let stored = initial;
  let updateCount = 0;
  const db = {
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
          returning: () => ({
            pipe: () => {
              updateCount += 1;
              if (stale) return Effect.succeed([]);
              stored = { ...stored, ...values };
              return Effect.succeed([stored]);
            },
          }),
        }),
      }),
    }),
  } as unknown as DrizzleService["db"];
  return { db, stored: () => stored, updateCount: () => updateCount };
};

describe("text snippet persistence and authorization", () => {
  it("persists metadata only in UPLOADING state", async () => {
    let inserted: Record<string, unknown> | undefined;
    const stored = row({ uploadStatus: "UPLOADING", storageObjectId: null });
    const drizzle = {
      db: {
        insert: () => ({
          values: (values: Record<string, unknown>) => {
            inserted = values;
            return { returning: () => ({ pipe: () => Effect.succeed([stored]) }) };
          },
        }),
      } as unknown as DrizzleService["db"],
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

    expect(inserted).toEqual({
      id: stored.id,
      kind: "TEXT",
      title: "Text snippet",
      fileName: stored.fileName,
      byteSize: stored.byteSize,
      contentType: "text/plain; charset=utf-8",
      storageProvider: "GOOGLE_DRIVE",
      storageObjectId: null,
      ownerWorkosUserId: "user-1",
      uploadStatus: "UPLOADING",
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
});
