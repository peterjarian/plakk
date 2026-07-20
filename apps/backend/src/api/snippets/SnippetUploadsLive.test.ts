import { Drizzle, type DrizzleService } from "@plakk/db";
import { snippets, type SnippetRow } from "@plakk/db/schema";
import { describe, expect, it, vi } from "vite-plus/test";
import { DateTime, Effect } from "effect";

import { StorageProviderService } from "../storage/StorageProvider.ts";
import { SnippetUploads } from "./SnippetUploads.ts";
import { SnippetUploadsLive } from "./SnippetUploadsLive.ts";

const now = DateTime.toDateUtc(DateTime.makeUnsafe("2026-07-20T20:00:00.000Z"));
const publication = {
  id: "0d1e2f3a-4567-4890-8abc-def012345678",
  fileName: "note.txt",
  byteSize: 4,
  storageProvider: "GOOGLE_DRIVE" as const,
  storageObjectId: "drive-object",
};
const row = (overrides: Partial<SnippetRow> = {}): SnippetRow => ({
  ...publication,
  ownerWorkosUserId: "user-1",
  deletedAt: null,
  createdAt: now,
  updatedAt: now,
  ...overrides,
});

const database = (
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

const storage = () => {
  const prepareUpload = vi.fn(() =>
    Effect.succeed({
      storageProvider: "GOOGLE_DRIVE" as const,
      storageObjectId: null,
      upload: {
        method: "PUT" as const,
        url: "https://upload.example",
        headers: [],
        strategy: { type: "single_request" as const },
      },
      expiresAt: null,
    }),
  );
  return {
    prepareUpload,
    service: StorageProviderService.of({
      prepareUpload,
      ensureConnected: () => Effect.void,
      getDestinationUrl: () => Effect.succeed("https://drive.example/folder"),
      downloadObject: () => Effect.succeed(new Uint8Array()),
      getDownloadUrl: () => Effect.succeed("https://download.example"),
      getDownloadTarget: () => Effect.succeed({ url: "https://download.example", headers: [] }),
    }),
  };
};

const runWith = <A, E>(
  store: ReturnType<typeof database>,
  provider: ReturnType<typeof storage>["service"],
  effect: Effect.Effect<A, E, SnippetUploads>,
) =>
  Effect.runPromise(
    effect.pipe(
      Effect.provide(SnippetUploadsLive),
      Effect.provideService(Drizzle, { db: store.db }),
      Effect.provideService(StorageProviderService, provider),
    ),
  );

describe("completed Snippet publication", () => {
  it("prepares an authenticated provider destination without creating a Snippet", async () => {
    const store = database();
    const provider = storage();
    const input = { ...publication, mediaType: "text/plain" };
    const { storageObjectId: _storageObjectId, ...prepareInput } = input;

    await runWith(
      store,
      provider.service,
      SnippetUploads.use((uploads) => uploads.prepare("user-1", prepareInput)),
    );

    expect(provider.prepareUpload).toHaveBeenCalledWith({
      snippetId: publication.id,
      storageProvider: publication.storageProvider,
      fileName: publication.fileName,
      byteSize: publication.byteSize,
      contentType: "text/plain",
      workosUserId: "user-1",
    });
    expect(store.insertedValues).toEqual([]);
  });

  it("inserts only the completed Snippet and notifies before commit", async () => {
    const stored = row();
    const store = database({ inserted: [stored] });
    const provider = storage();

    const result = await runWith(
      store,
      provider.service,
      SnippetUploads.use((uploads) => uploads.publish("user-1", publication)),
    );

    expect(result).toEqual({
      ...publication,
      createdAt: now.toISOString(),
      updatedAt: now.toISOString(),
    });
    expect(store.insertedValues[0]).toMatchObject({
      ...publication,
      ownerWorkosUserId: "user-1",
    });
    expect(store.events).toEqual(["insert", "notify", "commit"]);
  });

  it("returns an identical publication idempotently without another notification", async () => {
    const store = database({ inserted: [], selected: [row()] });

    const result = await runWith(
      store,
      storage().service,
      SnippetUploads.use((uploads) => uploads.publish("user-1", publication)),
    );

    expect(result.id).toBe(publication.id);
    expect(store.events).toEqual(["insert", "commit"]);
  });

  it("rejects conflicting identity reuse and account-mismatched conflicts", async () => {
    const different = database({
      inserted: [],
      selected: [row({ storageObjectId: "different-object" })],
    });
    await expect(
      runWith(
        different,
        storage().service,
        SnippetUploads.use((uploads) => uploads.publish("user-1", publication)),
      ),
    ).rejects.toMatchObject({ code: "CONFLICT" });

    const otherAccount = database({ inserted: [], selected: [] });
    await expect(
      runWith(
        otherAccount,
        storage().service,
        SnippetUploads.use((uploads) => uploads.publish("user-2", publication)),
      ),
    ).rejects.toMatchObject({ code: "CONFLICT" });
  });
});
