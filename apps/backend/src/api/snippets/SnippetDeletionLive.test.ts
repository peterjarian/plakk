import { Drizzle, type DrizzleService } from "@plakk/db";
import { snippets, type SnippetRow } from "@plakk/db/schema";
import { describe, expect, it, vi } from "vite-plus/test";
import { DateTime, Effect, Layer } from "effect";

import { StorageProviderService } from "../storage/StorageProvider.ts";
import { StorageProviderError } from "../storage/types.ts";
import { SnippetDeletion, SnippetDeletionLive } from "./SnippetDeletion.ts";

const now = DateTime.toDateUtc(DateTime.makeUnsafe("2026-07-20T20:00:00.000Z"));
const snippet = (overrides: Partial<SnippetRow> = {}): SnippetRow => ({
  id: "0d1e2f3a-4567-4890-8abc-def012345678",
  ownerWorkosUserId: "user-1",
  storageProvider: "GOOGLE_DRIVE",
  storageObjectId: "drive-object",
  fileName: "note.txt",
  byteSize: 4,
  createdAt: now,
  updatedAt: now,
  ...overrides,
});

const queryValues = (condition: unknown): ReadonlyArray<unknown> => {
  if (condition === null || typeof condition !== "object") return [];
  if (condition.constructor.name === "Param" && "value" in condition) {
    return [condition.value];
  }
  if ("queryChunks" in condition && Array.isArray(condition.queryChunks)) {
    return condition.queryChunks.flatMap(queryValues);
  }
  return [];
};

const database = (rows: ReadonlyArray<SnippetRow>) => {
  const events: Array<string> = [];
  const db = {
    transaction: <A, E, R>(body: (tx: DrizzleService["db"]) => Effect.Effect<A, E, R>) =>
      body(db as unknown as DrizzleService["db"]).pipe(
        Effect.tap(() =>
          Effect.sync(() => {
            events.push("commit");
          }),
        ),
      ),
    delete: (table: unknown) => {
      if (table !== snippets) throw new Error("Unexpected delete table.");
      return {
        where: (condition: unknown) => ({
          returning: () =>
            Effect.sync(() => {
              events.push("remove");
              const values = queryValues(condition);
              return rows.filter(
                (row) => values.includes(row.id) && values.includes(row.ownerWorkosUserId),
              );
            }),
        }),
      };
    },
    execute: () =>
      Effect.sync(() => {
        events.push("notify");
      }),
  } as unknown as DrizzleService["db"];
  return { db, events };
};

const storage = (
  events: Array<string>,
  deleteObject: (input: unknown) => Effect.Effect<void, StorageProviderError> = () => Effect.void,
) => {
  const remove = vi.fn((input: unknown) =>
    Effect.sync(() => {
      events.push("provider-delete");
    }).pipe(Effect.andThen(deleteObject(input))),
  );
  return {
    remove,
    service: StorageProviderService.of({
      deleteObject: remove,
      downloadObject: () => Effect.die("unused"),
      ensureConnected: () => Effect.die("unused"),
      getDestinationUrl: () => Effect.die("unused"),
      getDownloadTarget: () => Effect.die("unused"),
      getDownloadUrl: () => Effect.die("unused"),
      prepareUpload: () => Effect.die("unused"),
    }),
  };
};

const runWith = <A, E>(
  store: ReturnType<typeof database>,
  provider: StorageProviderService["Service"],
  effect: Effect.Effect<A, E, SnippetDeletion>,
) =>
  Effect.runPromise(
    effect.pipe(
      Effect.provide(
        SnippetDeletionLive.pipe(
          Layer.provide(
            Layer.mergeAll(
              Layer.succeed(Drizzle, { db: store.db }),
              Layer.succeed(StorageProviderService, provider),
            ),
          ),
        ),
      ),
    ),
  );

describe("completed Snippet deletion", () => {
  it("commits removal and notification before deleting the provider object once", async () => {
    const stored = snippet();
    const store = database([stored]);
    const provider = storage(store.events);

    await runWith(
      store,
      provider.service,
      SnippetDeletion.use((deletion) => deletion.delete("user-1", stored.id)),
    );

    expect(store.events).toEqual(["remove", "notify", "commit", "provider-delete"]);
    expect(provider.remove).toHaveBeenCalledOnce();
    expect(provider.remove).toHaveBeenCalledWith({
      storageProvider: stored.storageProvider,
      storageObjectId: stored.storageObjectId,
      workosUserId: stored.ownerWorkosUserId,
    });
  });

  it("keeps the Snippet removed when one provider cleanup attempt fails", async () => {
    const stored = snippet();
    const store = database([stored]);
    const provider = storage(store.events, () =>
      Effect.fail(
        new StorageProviderError({
          storageProvider: stored.storageProvider,
          message: "provider unavailable",
        }),
      ),
    );

    await expect(
      runWith(
        store,
        provider.service,
        SnippetDeletion.use((deletion) => deletion.delete("user-1", stored.id)),
      ),
    ).resolves.toBeUndefined();

    expect(store.events).toEqual(["remove", "notify", "commit", "provider-delete"]);
    expect(provider.remove).toHaveBeenCalledOnce();
  });

  it("does not notify or clean up when the account owns no matching Snippet", async () => {
    const store = database([snippet({ ownerWorkosUserId: "user-1" })]);
    const provider = storage(store.events);

    await runWith(
      store,
      provider.service,
      SnippetDeletion.use((deletion) =>
        deletion.delete("other-user", "0d1e2f3a-4567-4890-8abc-def012345678"),
      ),
    );

    expect(store.events).toEqual(["remove", "commit"]);
    expect(provider.remove).not.toHaveBeenCalled();
  });
});
