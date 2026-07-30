import {
  Drizzle,
  PostgresNotificationError,
  PostgresNotifications,
  type DrizzleService,
} from "@plakk/db";
import { snippets, type SnippetRow } from "@plakk/db/schema";
import {
  CurrentUser,
  SNIPPET_INVALIDATION_KEEP_ALIVE,
  SNIPPETS_CHANGED,
} from "@plakk/shared/PlakkApi";
import { describe, expect, it, vi } from "vite-plus/test";
import { DateTime, Effect, Fiber, Stream } from "effect";
import { TestClock } from "effect/testing";

import {
  StorageCredentialsError,
  StorageDownloadRejectedError,
  type StorageDownloadError,
  StorageNeedsReauthorizationError,
  StorageNotConnectedError,
  StorageObjectNotFoundError,
  StorageProviderError,
  StorageProvider,
} from "../storage/StorageProvider.ts";
import { SnippetRpcsLive } from "./SnippetRpcsLive.ts";

type SnippetRpcsHandlers = Effect.Success<typeof SnippetRpcsLive>;

const timestamp = DateTime.toDateUtc(DateTime.makeUnsafe("2026-07-20T20:00:00.000Z"));
const currentUser = {
  id: "user-1",
  firstName: null,
  lastName: null,
  email: null,
  createdAt: null,
  updatedAt: null,
};
const publication = {
  id: "0d1e2f3a-4567-4890-8abc-def012345678",
  fileName: "note.txt",
  byteSize: 4,
  storageProvider: "GOOGLE_DRIVE" as const,
  storageObjectId: "drive-object",
};
const snippet = (overrides: Partial<SnippetRow> = {}): SnippetRow => ({
  ...publication,
  title: null,
  ownerWorkosUserId: currentUser.id,
  createdAt: timestamp,
  updatedAt: timestamp,
  ...overrides,
});

const storageService = (
  overrides: Partial<StorageProvider["Service"]> = {},
): StorageProvider["Service"] =>
  StorageProvider.of({
    deleteObject: () => Effect.void,
    downloadStream: () => Stream.empty,
    ensureConnected: () => Effect.void,
    getDestinationUrl: () => Effect.succeed("https://drive.example/folder"),
    getLinkedProvider: () => Effect.succeed("GOOGLE_DRIVE"),
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
    ...overrides,
  });

const withSnippetRpcs = <A, E, R>(
  use: (rpcs: SnippetRpcsHandlers) => Effect.Effect<A, E, R>,
  listen: PostgresNotifications["Service"]["listen"] = () => Stream.never,
) =>
  Effect.gen(function* () {
    const rpcs = yield* SnippetRpcsLive;
    return yield* use(rpcs);
  }).pipe(
    Effect.scoped,
    Effect.provideService(PostgresNotifications, PostgresNotifications.of({ listen })),
  );

const runSnippetEffect = <A, E>(
  use: (rpcs: SnippetRpcsHandlers) => Effect.Effect<A, E, CurrentUser | Drizzle | StorageProvider>,
  db: DrizzleService["db"],
  storage: StorageProvider["Service"] = storageService(),
  user: CurrentUser["Service"] = currentUser,
) =>
  Effect.runPromise(
    withSnippetRpcs(use).pipe(
      Effect.provideService(CurrentUser, user),
      Effect.provideService(Drizzle, { db }),
      Effect.provideService(StorageProvider, storage),
    ),
  );

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

const publicationDatabase = (
  options: {
    inserted?: ReadonlyArray<SnippetRow>;
    selected?: ReadonlyArray<SnippetRow>;
  } = {},
) => {
  const events: Array<string> = [];
  const insertedValues: Array<Record<string, unknown>> = [];
  const db = {
    transaction: <A, E, R>(body: (tx: DrizzleService["db"]) => Effect.Effect<A, E, R>) =>
      body(db as unknown as DrizzleService["db"]).pipe(
        Effect.tap(() => Effect.sync(() => void events.push("commit"))),
      ),
    insert: (table: unknown) => {
      if (table !== snippets) throw new Error("Unexpected insert table.");
      return {
        values: (values: Record<string, unknown>) => {
          insertedValues.push(values);
          return {
            onConflictDoNothing: () => ({
              returning: () =>
                Effect.sync(() => {
                  events.push("insert");
                  return options.inserted ?? [];
                }),
            }),
          };
        },
      };
    },
    select: () => ({
      from: (table: unknown) => {
        if (table !== snippets) throw new Error("Unexpected select table.");
        return {
          where: () => ({
            limit: () => Effect.succeed(options.selected ?? []),
          }),
        };
      },
    }),
    execute: () =>
      Effect.sync(() => {
        events.push("notify");
      }),
  } as unknown as DrizzleService["db"];
  return { db, events, insertedValues };
};

const deletionDatabase = (rows: ReadonlyArray<SnippetRow>) => {
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

const downloadDatabase = (rows: ReadonlyArray<SnippetRow>) =>
  ({
    select: () => ({
      from: () => ({
        where: () => ({
          limit: () => ({ pipe: () => Effect.succeed(rows) }),
        }),
      }),
    }),
  }) as unknown as DrizzleService["db"];

describe("snippet invalidation RPC", () => {
  it("keeps an idle stream alive without disguising the heartbeat as a change", async () => {
    const events = await Effect.runPromise(
      withSnippetRpcs((rpcs) =>
        Effect.gen(function* () {
          const fiber = yield* rpcs
            .WatchSnippetInvalidations()
            .pipe(Stream.take(2), Stream.runCollect, Effect.forkChild);
          yield* TestClock.adjust("15 seconds");
          return yield* Fiber.join(fiber);
        }),
      ).pipe(Effect.provideService(CurrentUser, currentUser), Effect.provide(TestClock.layer())),
    );

    expect(new Set(events)).toEqual(new Set([SNIPPETS_CHANGED, SNIPPET_INVALIDATION_KEEP_ALIVE]));
  });

  it("emits an initial refresh and only the authenticated account's notifications", async () => {
    const events = await Effect.runPromise(
      withSnippetRpcs(
        (rpcs) => rpcs.WatchSnippetInvalidations().pipe(Stream.take(2), Stream.runCollect),
        () =>
          Stream.make(
            { _tag: "Connected" },
            { _tag: "Notification", payload: "account-2" },
            { _tag: "Notification", payload: currentUser.id },
          ),
      ).pipe(Effect.provideService(CurrentUser, currentUser)),
    );

    expect(Array.from(events)).toEqual([SNIPPETS_CHANGED, SNIPPETS_CHANGED]);
  });

  it("reconnects the PostgreSQL listener without ending the RPC stream", async () => {
    let attempts = 0;
    const listen = () => {
      attempts += 1;
      return attempts === 1
        ? Stream.concat(
            Stream.succeed({ _tag: "Connected" as const }),
            Stream.fail(new PostgresNotificationError({ cause: "connection dropped" })),
          )
        : Stream.succeed({ _tag: "Connected" as const });
    };
    const events = await Effect.runPromise(
      withSnippetRpcs(
        (rpcs) =>
          Effect.gen(function* () {
            const fiber = yield* rpcs
              .WatchSnippetInvalidations()
              .pipe(Stream.take(2), Stream.runCollect, Effect.forkChild);
            yield* Effect.yieldNow;
            yield* Effect.yieldNow;
            yield* TestClock.adjust("1 second");
            return yield* Fiber.join(fiber);
          }),
        listen,
      ).pipe(Effect.provideService(CurrentUser, currentUser), Effect.provide(TestClock.layer())),
    );

    expect(Array.from(events)).toEqual([SNIPPETS_CHANGED, SNIPPETS_CHANGED]);
    expect(attempts).toBe(2);
  });
});

describe("completed Snippet publication", () => {
  it("prepares an authenticated provider destination without creating a Snippet", async () => {
    const store = publicationDatabase();
    const prepareUpload = vi.fn(storageService().prepareUpload);
    const input = { ...publication, mediaType: "text/plain" };
    const { storageObjectId: _storageObjectId, ...prepareInput } = input;

    await runSnippetEffect(
      (rpcs) => rpcs.PrepareSnippetUpload(prepareInput),
      store.db,
      storageService({ prepareUpload }),
      { ...currentUser, requestOrigin: "https://web.plakk.example" },
    );

    expect(prepareUpload).toHaveBeenCalledWith({
      snippetId: publication.id,
      storageProvider: publication.storageProvider,
      fileName: publication.fileName,
      byteSize: publication.byteSize,
      contentType: "text/plain",
      origin: "https://web.plakk.example",
      workosUserId: currentUser.id,
    });
    expect(store.insertedValues).toEqual([]);
  });

  it("inserts only the completed Snippet and notifies before commit", async () => {
    const titledPublication = { ...publication, title: "A stable title" };
    const stored = snippet({ title: titledPublication.title });
    const store = publicationDatabase({ inserted: [stored] });

    const result = await runSnippetEffect(
      (rpcs) => rpcs.PublishSnippet(titledPublication),
      store.db,
    );

    expect(result).toEqual({
      ...titledPublication,
      createdAt: timestamp.toISOString(),
      updatedAt: timestamp.toISOString(),
    });
    expect(store.insertedValues[0]).toMatchObject({
      ...titledPublication,
      ownerWorkosUserId: currentUser.id,
    });
    expect(store.events).toEqual(["insert", "notify", "commit"]);
  });

  it("rejects an idempotent replay when its immutable title differs", async () => {
    const stored = snippet({ title: "Original title" });

    await expect(
      runSnippetEffect(
        (rpcs) => rpcs.PublishSnippet({ ...publication, title: "Different title" }),
        publicationDatabase({ selected: [stored] }).db,
      ),
    ).rejects.toMatchObject({ code: "CONFLICT" });
  });

  it("returns an identical publication idempotently without another notification", async () => {
    const store = publicationDatabase({ inserted: [], selected: [snippet()] });

    const result = await runSnippetEffect((rpcs) => rpcs.PublishSnippet(publication), store.db);

    expect(result.id).toBe(publication.id);
    expect(store.events).toEqual(["insert", "commit"]);
  });

  it("rejects conflicting identity reuse and account-mismatched conflicts", async () => {
    const different = publicationDatabase({
      inserted: [],
      selected: [snippet({ storageObjectId: "different-object" })],
    });
    await expect(
      runSnippetEffect((rpcs) => rpcs.PublishSnippet(publication), different.db),
    ).rejects.toMatchObject({ code: "CONFLICT" });

    const otherAccount = publicationDatabase({ inserted: [], selected: [] });
    await expect(
      runSnippetEffect(
        (rpcs) => rpcs.PublishSnippet(publication),
        otherAccount.db,
        storageService(),
        { ...currentUser, id: "user-2" },
      ),
    ).rejects.toMatchObject({ code: "CONFLICT" });
  });
});

describe("complete Snippet snapshots", () => {
  it("returns the complete ordered query result directly", async () => {
    const stored = snippet();
    const db = {
      select: () => ({
        from: () => ({
          where: () => ({
            orderBy: () => ({ pipe: () => Effect.succeed([stored]) }),
          }),
        }),
      }),
    } as unknown as DrizzleService["db"];

    const result = await runSnippetEffect((rpcs) => rpcs.GetSnippetSnapshot(), db);

    expect(result).toEqual([
      expect.objectContaining({
        id: stored.id,
        storageObjectId: "drive-object",
      }),
    ]);
  });
});

describe("stored snippet content download", () => {
  it("streams bytes through the backend without exposing provider credentials", async () => {
    const bytes = new TextEncoder().encode("note");
    const downloadStream = vi.fn(() => Stream.succeed(bytes));

    const result = await runSnippetEffect(
      (rpcs) =>
        rpcs.DownloadSnippetContent({ id: publication.id }).pipe(
          Stream.runCollect,
          Effect.map((chunks) => Uint8Array.from(chunks.flatMap((chunk) => Array.from(chunk)))),
        ),
      downloadDatabase([snippet()]),
      storageService({ downloadStream }),
    );

    expect(result).toEqual(bytes);
    expect(downloadStream).toHaveBeenCalledWith({
      storageProvider: "GOOGLE_DRIVE",
      storageObjectId: "drive-object",
      expectedByteSize: 4,
      workosUserId: currentUser.id,
    });
  });

  it("does not access storage when no uploaded object is available", async () => {
    const downloadStream = vi.fn(storageService().downloadStream);

    await expect(
      runSnippetEffect(
        (rpcs) => rpcs.DownloadSnippetContent({ id: publication.id }).pipe(Stream.runDrain),
        downloadDatabase([]),
        storageService({ downloadStream }),
      ),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect(downloadStream).not.toHaveBeenCalled();
  });

  it("marks terminal provider rejections as non-retryable", async () => {
    const downloadStream = () =>
      Stream.fail(
        new StorageDownloadRejectedError({
          storageProvider: "GOOGLE_DRIVE",
          status: 403,
          message: "provider rejected download",
        }),
      );

    await expect(
      runSnippetEffect(
        (rpcs) => rpcs.DownloadSnippetContent({ id: publication.id }).pipe(Stream.runDrain),
        downloadDatabase([snippet()]),
        storageService({ downloadStream }),
      ),
    ).rejects.toMatchObject({
      code: "INTERNAL_SERVER_ERROR",
      retryable: false,
    });
  });

  it("marks provider integrity failures as non-retryable", async () => {
    const downloadStream = () =>
      Stream.fail(
        new StorageProviderError({
          storageProvider: "GOOGLE_DRIVE",
          message: "Stored object size does not match snippet metadata.",
          retryable: false,
        }),
      );

    await expect(
      runSnippetEffect(
        (rpcs) => rpcs.DownloadSnippetContent({ id: publication.id }).pipe(Stream.runDrain),
        downloadDatabase([snippet()]),
        storageService({ downloadStream }),
      ),
    ).rejects.toMatchObject({
      code: "INTERNAL_SERVER_ERROR",
      retryable: false,
    });
  });

  it.each([
    [
      new StorageObjectNotFoundError({
        storageProvider: "GOOGLE_DRIVE",
        message: "missing",
      }),
      "NOT_FOUND",
      "missing",
    ],
    [new StorageNotConnectedError({ message: "connect storage" }), "FORBIDDEN", "connect storage"],
    [
      new StorageNeedsReauthorizationError({ message: "reconnect storage" }),
      "FORBIDDEN",
      "reconnect storage",
    ],
    [
      new StorageCredentialsError({ message: "credentials unavailable" }),
      "INTERNAL_SERVER_ERROR",
      "credentials unavailable",
    ],
    [
      new StorageProviderError({
        storageProvider: "GOOGLE_DRIVE",
        message: "provider failed",
      }),
      "INTERNAL_SERVER_ERROR",
      "GOOGLE_DRIVE: provider failed",
    ],
  ] as const)("maps %s to %s", async (storageError, code, message) => {
    const downloadStream = () => Stream.fail(storageError as StorageDownloadError);

    await expect(
      runSnippetEffect(
        (rpcs) => rpcs.DownloadSnippetContent({ id: publication.id }).pipe(Stream.runDrain),
        downloadDatabase([snippet()]),
        storageService({ downloadStream }),
      ),
    ).rejects.toMatchObject({ code, message });
  });
});

describe("completed Snippet deletion", () => {
  it("commits removal and notification before deleting the provider object once", async () => {
    const stored = snippet();
    const store = deletionDatabase([stored]);
    const deleteObject = vi.fn(() =>
      Effect.sync(() => {
        store.events.push("provider-delete");
      }),
    );

    await runSnippetEffect(
      (rpcs) => rpcs.DeleteSnippet({ id: stored.id }),
      store.db,
      storageService({ deleteObject }),
    );

    expect(store.events).toEqual(["remove", "notify", "commit", "provider-delete"]);
    expect(deleteObject).toHaveBeenCalledOnce();
    expect(deleteObject).toHaveBeenCalledWith({
      storageProvider: stored.storageProvider,
      storageObjectId: stored.storageObjectId,
      workosUserId: stored.ownerWorkosUserId,
    });
  });

  it("keeps the Snippet removed when one provider cleanup attempt fails", async () => {
    const stored = snippet();
    const store = deletionDatabase([stored]);
    const deleteObject = vi.fn(() =>
      Effect.sync(() => {
        store.events.push("provider-delete");
      }).pipe(
        Effect.andThen(
          Effect.fail(
            new StorageProviderError({
              storageProvider: stored.storageProvider,
              message: "provider unavailable",
            }),
          ),
        ),
      ),
    );

    await expect(
      runSnippetEffect(
        (rpcs) => rpcs.DeleteSnippet({ id: stored.id }),
        store.db,
        storageService({ deleteObject }),
      ),
    ).resolves.toBeUndefined();

    expect(store.events).toEqual(["remove", "notify", "commit", "provider-delete"]);
    expect(deleteObject).toHaveBeenCalledOnce();
  });

  it("does not notify or clean up when the account owns no matching Snippet", async () => {
    const store = deletionDatabase([snippet()]);
    const deleteObject = vi.fn(storageService().deleteObject);

    await runSnippetEffect(
      (rpcs) => rpcs.DeleteSnippet({ id: publication.id }),
      store.db,
      storageService({ deleteObject }),
      { ...currentUser, id: "other-user" },
    );

    expect(store.events).toEqual(["remove", "commit"]);
    expect(deleteObject).not.toHaveBeenCalled();
  });
});
