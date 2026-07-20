import type { DrizzleService } from "@plakk/db";
import type { SnippetRow } from "@plakk/db/schema";
import { describe, expect, it, vi } from "vite-plus/test";
import { DateTime, Effect } from "effect";

import type { StorageProviderService } from "./storage/StorageProvider.ts";
import { deleteSnippetRecord, prepareSnippetDownload } from "./PlakkApiLive.ts";

const timestamp = DateTime.toDateUtc(DateTime.makeUnsafe("2026-07-15T12:00:00Z"));

const uploadedSnippet = (overrides: Partial<SnippetRow> = {}): SnippetRow => ({
  id: "0d1e2f3a-4567-4890-8abc-def012345678",
  ownerWorkosUserId: "user-1",
  storageProvider: "GOOGLE_DRIVE",
  storageObjectId: "drive-object",
  fileName: "note.md",
  byteSize: 12,
  deletedAt: null,
  createdAt: timestamp,
  updatedAt: timestamp,
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

describe("stored snippet download preparation", () => {
  it("returns only durable metadata and a short-lived download target", async () => {
    const snippet = uploadedSnippet();
    const download = { url: "https://download.example/object", headers: [] };
    const getDownloadTarget = vi.fn(() => Effect.succeed(download));
    const storage = { getDownloadTarget } as unknown as StorageProviderService["Service"];

    const result = await Effect.runPromise(
      prepareSnippetDownload({ db: queryDb([snippet]) }, storage, "user-1", snippet.id),
    );

    expect(result).toEqual({
      storageProvider: "GOOGLE_DRIVE",
      fileName: "note.md",
      byteSize: 12,
      download,
    });
    expect(getDownloadTarget).toHaveBeenCalledWith({
      storageProvider: "GOOGLE_DRIVE",
      storageObjectId: "drive-object",
      workosUserId: "user-1",
    });
  });

  it("does not resolve a download target when no uploaded object is available", async () => {
    const getDownloadTarget = vi.fn();
    const storage = { getDownloadTarget } as unknown as StorageProviderService["Service"];

    const error = await Effect.runPromise(
      Effect.flip(prepareSnippetDownload({ db: queryDb([]) }, storage, "user-1", "missing")),
    );

    expect(error).toMatchObject({ code: "NOT_FOUND" });
    expect(getDownloadTarget).not.toHaveBeenCalled();
  });
});

describe("Snippet deletion transaction", () => {
  it("stages account invalidation after removal and exposes it only with commit", async () => {
    const events: Array<"remove" | "notify" | "commit"> = [];
    const db = {
      transaction: <A, E, R>(body: (transaction: DrizzleService["db"]) => Effect.Effect<A, E, R>) =>
        body(db as unknown as DrizzleService["db"]).pipe(
          Effect.tap(() =>
            Effect.sync(() => {
              events.push("commit");
            }),
          ),
        ),
      update: () => ({
        set: () => ({
          where: () => ({
            returning: () =>
              Effect.sync(() => {
                events.push("remove");
                return [uploadedSnippet()];
              }),
          }),
        }),
      }),
      execute: () =>
        Effect.sync(() => {
          events.push("notify");
        }),
    } as unknown as DrizzleService["db"];

    const deleted = await Effect.runPromise(
      deleteSnippetRecord({ db }, "user-1", uploadedSnippet().id),
    );

    expect(deleted).toBe(true);
    expect(events).toEqual(["remove", "notify", "commit"]);
  });
});
