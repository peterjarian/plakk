import { SqliteClient } from "@effect/sql-sqlite-node";
import { describe, expect, it } from "@effect/vitest";
import type { User } from "@plakk/shared";
import { OfflineError, SessionError, type ApiSnippet } from "@plakk/shared/PlakkApi";
import { RpcError } from "@plakk/shared/RpcError";
import { Deferred, Effect, Fiber, Layer, Option, Stream } from "effect";
import { TestClock } from "effect/testing";
import { HttpClient, HttpClientResponse } from "effect/unstable/http";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { CurrentSession } from "./CurrentSession.ts";
import { clearClientMetadata } from "./Client.ts";
import { LocalStorageError } from "./models/ClientError.ts";
import { RpcClient } from "./RpcClient.ts";
import {
  ContentMirror,
  ContentStore,
  DownloadedContentMismatchError,
} from "./snippets/ContentMirror.ts";
import { SnippetStore } from "./snippets/SnippetStore.ts";
import { SyncEngine } from "./snippets/SyncEngine.ts";
import { UploadEngine, UploadSourceUnavailableError } from "./snippets/UploadEngine.ts";
import { clientMigrationsLayer, runMigrations } from "./sqlite/Migrations.ts";
import { listSnippets } from "./sqlite/queries/snippets.ts";

const user: User = {
  id: "user-1",
  firstName: "Test",
  lastName: "User",
  email: "test@example.com",
  createdAt: "2026-07-20T18:00:00.000Z",
  updatedAt: "2026-07-20T18:00:00.000Z",
};
const session = { user, accessToken: Effect.succeed("token") } as const;
const localId = "0d1e2f3a-4567-4890-8abc-def012345678";
const publishedId = "1d1e2f3a-4567-4890-8abc-def012345678";
const published: ApiSnippet = {
  id: publishedId,
  fileName: "published.txt",
  byteSize: 4,
  storageProvider: "GOOGLE_DRIVE",
  storageObjectId: "drive-object",
  createdAt: "2026-07-20T20:00:00.000Z",
  updatedAt: "2026-07-20T20:00:00.000Z",
};

type RpcOverrides = Partial<Record<keyof RpcClient["Service"], unknown>>;
type SnapshotInput = Parameters<RpcClient["Service"]["GetSnippetSnapshot"]>[0];
type PrepareUploadInput = Parameters<RpcClient["Service"]["PrepareSnippetUpload"]>[0];
type PublishInput = Parameters<RpcClient["Service"]["PublishSnippet"]>[0];

const makeRpc = (overrides: RpcOverrides = {}): RpcClient["Service"] =>
  RpcClient.of({
    BeginStorageProviderLink: () => Effect.die("not used"),
    DeleteSnippet: () => Effect.void,
    DownloadSnippetContent: () => Stream.die("not used"),
    GetAccountStatus: () => Effect.die("not used"),
    GetSnippetSnapshot: () => Effect.succeed([]),
    GetStorageProviderStatus: () => Effect.die("not used"),
    Ping: () => Effect.die("not used"),
    PrepareSnippetUpload: () => Effect.die("not used"),
    PublishSnippet: () => Effect.die("not used"),
    UnlinkStorageProvider: () => Effect.die("not used"),
    WatchSnippetInvalidations: () => Stream.never,
    ...overrides,
  } as RpcClient["Service"]);

const makeLayer = (
  rpc: RpcClient["Service"],
  response: (request: Parameters<typeof HttpClientResponse.fromWeb>[0]) => Response = () =>
    new Response(JSON.stringify({ id: "drive-object" }), {
      status: 200,
      headers: { "content-type": "application/json" },
    }),
  options?: {
    readonly contentRemoveError?: LocalStorageError;
    readonly httpDelayMilliseconds?: number;
    readonly localContent?: Map<string, Uint8Array> | false;
  },
) => {
  const sqliteLayer = SqliteClient.layer({ filename: ":memory:" });
  const databaseLayer = clientMigrationsLayer.pipe(Layer.provideMerge(sqliteLayer));
  const httpLayer = Layer.succeed(
    HttpClient.HttpClient,
    HttpClient.make((request) =>
      Effect.sleep(options?.httpDelayMilliseconds ?? 0).pipe(
        Effect.andThen(Effect.sync(() => HttpClientResponse.fromWeb(request, response(request)))),
      ),
    ),
  );
  const contentLayer =
    options?.localContent === false
      ? Layer.empty
      : (() => {
          const stored = options?.localContent ?? new Map<string, Uint8Array>();
          return Layer.succeed(
            ContentStore,
            ContentStore.of({
              entries: Effect.sync(() =>
                Array.from(stored.entries(), ([snippetId, bytes]) => ({
                  snippetId,
                  byteSize: bytes.byteLength,
                })),
              ),
              write: (snippetId, expectedByteSize, source) =>
                Stream.runCollect(source).pipe(
                  Effect.flatMap((chunks) => {
                    const bytes = new Uint8Array(
                      chunks.reduce((size, chunk) => size + chunk.byteLength, 0),
                    );
                    let offset = 0;
                    for (const chunk of chunks) {
                      bytes.set(chunk, offset);
                      offset += chunk.byteLength;
                    }
                    if (bytes.byteLength !== expectedByteSize) {
                      return Effect.fail(
                        new LocalStorageError({
                          message: "Unexpected test content size.",
                        }),
                      );
                    }
                    return Effect.sync(() => {
                      stored.set(snippetId, bytes);
                    });
                  }),
                ),
              read: (snippetId) => {
                const bytes = stored.get(snippetId);
                return bytes === undefined
                  ? Stream.fail(new LocalStorageError({ message: "Test content is missing." }))
                  : Stream.make(bytes);
              },
              readRange: (snippetId, offset, byteSize) => {
                const bytes = stored.get(snippetId);
                return bytes === undefined
                  ? Effect.fail(new LocalStorageError({ message: "Test content is missing." }))
                  : Effect.succeed(bytes.slice(offset, offset + byteSize));
              },
              remove: (snippetIds) =>
                options?.contentRemoveError === undefined
                  ? Effect.sync(() => {
                      for (const snippetId of snippetIds) stored.delete(snippetId);
                    })
                  : Effect.fail(options.contentRemoveError),
            }),
          );
        })();
  const dependencies = Layer.mergeAll(
    databaseLayer,
    contentLayer,
    httpLayer,
    Layer.succeed(CurrentSession, CurrentSession.of(session)),
    Layer.succeed(RpcClient, rpc),
  );
  const snippetsLayer = SnippetStore.Live.pipe(Layer.provide(dependencies));
  return Layer.mergeAll(
    SyncEngine.Live.pipe(Layer.provide(snippetsLayer)),
    UploadEngine.Live.pipe(Layer.provide(snippetsLayer)),
    ContentMirror.Live.pipe(Layer.provide(snippetsLayer)),
    snippetsLayer,
  ).pipe(Layer.provideMerge(dependencies));
};

describe("shared client integration", () => {
  it.effect("can initialize and clear browser metadata without starting the client", () =>
    Effect.gen(function* () {
      yield* clearClientMetadata(user.id);
      expect(yield* listSnippets(user.id)).toEqual([]);
    }).pipe(Effect.provide(SqliteClient.layer({ filename: ":memory:" }))),
  );

  it.effect("reports backend snippet-sync connection state", () => {
    const layer = makeLayer(
      makeRpc({
        WatchSnippetInvalidations: () => Stream.empty,
      }),
    );

    return Effect.gen(function* () {
      const sync = yield* SyncEngine;
      const statusesFiber = yield* sync
        .subscribe()
        .pipe(Stream.take(3), Stream.runCollect, Effect.forkChild);
      const syncFiber = yield* sync.run.pipe(Effect.forkChild);

      expect(Array.from(yield* Fiber.join(statusesFiber))).toEqual([
        "STARTING",
        "CONNECTED",
        "RECONNECTING",
      ]);
      yield* Fiber.interrupt(syncFiber);
    }).pipe(Effect.provide(layer));
  });

  it.effect("settles startup state when the initial snippet sync fails", () => {
    const layer = makeLayer(
      makeRpc({
        GetSnippetSnapshot: () =>
          Effect.fail(new OfflineError({ message: "Could not reach the backend." })),
      }),
    );

    return Effect.gen(function* () {
      const sync = yield* SyncEngine;
      const statusesFiber = yield* sync
        .subscribe()
        .pipe(Stream.take(2), Stream.runCollect, Effect.forkChild);
      const syncFiber = yield* sync.run.pipe(Effect.forkChild);

      expect(Array.from(yield* Fiber.join(statusesFiber))).toEqual(["STARTING", "RECONNECTING"]);
      yield* Fiber.interrupt(syncFiber);
    }).pipe(Effect.provide(layer));
  });

  it.effect("surfaces backend authentication rejection in sync state", () => {
    const layer = makeLayer(
      makeRpc({
        GetSnippetSnapshot: () =>
          Effect.fail(
            new RpcError({
              code: "UNAUTHENTICATED",
              message: "The access token expired.",
            }),
          ),
      }),
    );

    return Effect.gen(function* () {
      const sync = yield* SyncEngine;
      const statusesFiber = yield* sync
        .subscribe()
        .pipe(Stream.take(2), Stream.runCollect, Effect.forkChild);
      const syncFiber = yield* sync.run.pipe(Effect.forkChild);

      expect(Array.from(yield* Fiber.join(statusesFiber))).toEqual(["STARTING", "SESSION_ERROR"]);
      yield* Fiber.interrupt(syncFiber);
    }).pipe(Effect.provide(layer));
  });

  it.effect("tracks schema migrations and reruns them safely", () => {
    const layer = makeLayer(makeRpc());

    return Effect.gen(function* () {
      expect(yield* runMigrations()).toEqual([]);

      const sql = yield* SqlClient.SqlClient;
      const migrations = yield* sql<{
        readonly migration_id: number;
        readonly name: string;
      }>`
          SELECT migration_id, name
          FROM client_runtime_migrations
          ORDER BY migration_id
        `;
      expect(migrations).toEqual([
        { migration_id: 1, name: "initial" },
        { migration_id: 2, name: "account" },
        { migration_id: 3, name: "snippet_title" },
      ]);
    }).pipe(Effect.provide(layer));
  });

  it.effect("pulls published snippets without removing a pending upload", () => {
    const layer = makeLayer(
      makeRpc({
        GetSnippetSnapshot: (_input: SnapshotInput) => Effect.succeed([published]),
      }),
    );

    return Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* sql`
          INSERT INTO client_snippets (
            user_id,
            id,
            file_name,
            byte_size,
            storage_provider,
            storage_object_id,
            status,
            error_message,
            created_at,
            updated_at
          )
          VALUES (
            ${user.id},
            ${localId},
            'pending.txt',
            1,
            'GOOGLE_DRIVE',
            NULL,
            'UPLOADING',
            NULL,
            '2026-07-20T19:00:00.000Z',
            '2026-07-20T19:00:00.000Z'
          )
        `;

      const sync = yield* SyncEngine;
      yield* sync.pull;

      const snippets = yield* listSnippets(user.id);
      expect(snippets.map(({ id, status }) => ({ id, status }))).toEqual([
        { id: publishedId, status: "PUBLISHED" },
        { id: localId, status: "UPLOADING" },
      ]);
    }).pipe(Effect.provide(layer));
  });

  it.effect("converts backend authentication failures at the sync boundary", () => {
    const layer = makeLayer(
      makeRpc({
        DeleteSnippet: () =>
          Effect.fail(
            new RpcError({
              code: "UNAUTHENTICATED",
              message: "The access token expired.",
            }),
          ),
      }),
    );

    return Effect.gen(function* () {
      const error = yield* (yield* SyncEngine).delete(publishedId).pipe(Effect.flip);

      expect(error).toEqual(
        new SessionError({
          message: "Your session expired. Sign in again to continue.",
        }),
      );
    }).pipe(Effect.provide(layer));
  });

  it.effect("persists an upload before remote work and promotes it after publication", () =>
    Effect.gen(function* () {
      const prepareStarted = yield* Deferred.make<void>();
      const releasePrepare = yield* Deferred.make<void>();
      const uploaded = { ...published, id: localId, fileName: "note.txt", title: "note" };
      let publishInput: PublishInput | undefined;
      const layer = makeLayer(
        makeRpc({
          PrepareSnippetUpload: (_input: PrepareUploadInput) => {
            return Deferred.succeed(prepareStarted, undefined).pipe(
              Effect.andThen(Deferred.await(releasePrepare)),
              Effect.as({
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
            );
          },
          PublishSnippet: (input: PublishInput) => {
            publishInput = input;
            return Effect.succeed(uploaded);
          },
        }),
      );

      yield* Effect.gen(function* () {
        const uploads = yield* UploadEngine;
        const bytes = new TextEncoder().encode("note");
        yield* uploads.upload(
          {
            id: localId,
            fileName: "note.txt",
            byteSize: bytes.byteLength,
            storageProvider: "GOOGLE_DRIVE",
            mediaType: "text/plain",
          },
          {
            read: (offset, byteSize) => Effect.succeed(bytes.slice(offset, offset + byteSize)),
          },
        );

        yield* Deferred.await(prepareStarted);
        const pending = (yield* listSnippets(user.id)).find((snippet) => snippet.id === localId);
        expect(pending).toMatchObject({
          id: localId,
          title: "note",
          status: "UPLOADING",
          storageObjectId: null,
          localContentAvailability: { status: "AVAILABLE" },
        });

        const publishedSnapshot = yield* (yield* SnippetStore).subscribe().pipe(
          Stream.filter((snapshot) =>
            snapshot.some((snippet) => snippet.id === localId && snippet.status === "PUBLISHED"),
          ),
          Stream.runHead,
          Effect.forkChild,
        );
        yield* Deferred.succeed(releasePrepare, undefined);
        yield* Fiber.join(publishedSnapshot);

        const complete = (yield* listSnippets(user.id)).find((snippet) => snippet.id === localId);
        expect(complete).toMatchObject({
          id: localId,
          title: "note",
          status: "PUBLISHED",
          storageObjectId: "drive-object",
        });
        expect(publishInput).toMatchObject({ id: localId, title: "note" });
      }).pipe(Effect.provide(layer));
    }),
  );

  it.effect("uploads without requiring a local content store", () =>
    Effect.gen(function* () {
      const prepareStarted = yield* Deferred.make<void>();
      const releasePrepare = yield* Deferred.make<void>();
      const uploaded = { ...published, id: localId, fileName: "web-note.txt" };
      const layer = makeLayer(
        makeRpc({
          PrepareSnippetUpload: () =>
            Deferred.succeed(prepareStarted, undefined).pipe(
              Effect.andThen(Deferred.await(releasePrepare)),
              Effect.as({
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
            ),
          PublishSnippet: () => Effect.succeed(uploaded),
        }),
        undefined,
        { localContent: false },
      );

      yield* Effect.gen(function* () {
        const bytes = new TextEncoder().encode("note");
        const uploadFiber = yield* (yield* UploadEngine)
          .upload(
            {
              id: localId,
              fileName: "web-note.txt",
              byteSize: bytes.byteLength,
              storageProvider: "GOOGLE_DRIVE",
              mediaType: "text/plain",
            },
            {
              read: (offset, byteSize) => Effect.succeed(bytes.slice(offset, offset + byteSize)),
            },
          )
          .pipe(Effect.forkChild);

        yield* Deferred.await(prepareStarted);
        expect((yield* listSnippets(user.id))[0]).toMatchObject({
          id: localId,
          status: "UPLOADING",
          localContentAvailability: { status: "NOT_AVAILABLE" },
        });

        yield* Deferred.succeed(releasePrepare, undefined);
        yield* Fiber.join(uploadFiber);
        expect((yield* listSnippets(user.id))[0]).toMatchObject({
          id: localId,
          status: "PUBLISHED",
          localContentAvailability: { status: "NOT_AVAILABLE" },
        });
      }).pipe(Effect.provide(layer));
    }),
  );

  it.effect("keeps a failed row when title inspection cannot read the web source", () => {
    const layer = makeLayer(makeRpc(), undefined, { localContent: false });

    return Effect.gen(function* () {
      yield* (yield* UploadEngine).upload(
        {
          id: localId,
          fileName: "unavailable.txt",
          byteSize: 4,
          storageProvider: "GOOGLE_DRIVE",
          mediaType: "text/plain",
        },
        {
          read: () =>
            Effect.fail(
              new UploadSourceUnavailableError({
                message: "The browser file is no longer readable.",
              }),
            ),
        },
      );

      expect((yield* listSnippets(user.id))[0]).toMatchObject({
        id: localId,
        status: "FAILED",
        errorMessage: "Plakk could not read the selected file.",
      });
    }).pipe(Effect.provide(layer));
  });

  it.effect("does not derive a title unless the complete text source is valid UTF-8", () => {
    const bytes = new Uint8Array(64 * 1024 + 1).fill(0x61);
    bytes[bytes.byteLength - 1] = 0xff;
    let publishInput: PublishInput | undefined;
    const layer = makeLayer(
      makeRpc({
        PrepareSnippetUpload: () =>
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
        PublishSnippet: (input: PublishInput) => {
          publishInput = input;
          return Effect.succeed({
            ...published,
            id: localId,
            fileName: "invalid-tail.txt",
            byteSize: bytes.byteLength,
          });
        },
      }),
      undefined,
      { localContent: false },
    );

    return Effect.gen(function* () {
      yield* (yield* UploadEngine).upload(
        {
          id: localId,
          fileName: "invalid-tail.txt",
          byteSize: bytes.byteLength,
          storageProvider: "GOOGLE_DRIVE",
          mediaType: "text/plain",
        },
        {
          read: (offset, byteSize) => Effect.succeed(bytes.slice(offset, offset + byteSize)),
        },
      );

      expect(publishInput).not.toHaveProperty("title");
    }).pipe(Effect.provide(layer));
  });

  it.effect("removes managed content with a deleted snippet", () => {
    const stored = new Map([[publishedId, new Uint8Array([1, 2, 3, 4])]]);
    const layer = makeLayer(
      makeRpc({
        GetSnippetSnapshot: () => Effect.succeed([published]),
      }),
      undefined,
      { localContent: stored },
    );

    return Effect.gen(function* () {
      const sync = yield* SyncEngine;
      yield* sync.pull;
      yield* sync.delete(publishedId);

      expect(stored.has(publishedId)).toBe(false);
      expect(yield* listSnippets(user.id)).toEqual([]);
    }).pipe(Effect.provide(layer));
  });

  it.effect("keeps deletion successful when local content cleanup fails", () => {
    const stored = new Map([[publishedId, new Uint8Array([1, 2, 3, 4])]]);
    const layer = makeLayer(
      makeRpc({
        GetSnippetSnapshot: () => Effect.succeed([published]),
      }),
      undefined,
      {
        localContent: stored,
        contentRemoveError: new LocalStorageError({
          message: "The test content could not be removed.",
        }),
      },
    );

    return Effect.gen(function* () {
      const sync = yield* SyncEngine;
      yield* sync.pull;
      yield* sync.delete(publishedId);

      expect(yield* listSnippets(user.id)).toEqual([]);
      expect(stored.has(publishedId)).toBe(true);
    }).pipe(Effect.provide(layer));
  });

  it.effect("retries an offline upload without turning it into a failure", () =>
    Effect.gen(function* () {
      const firstAttempt = yield* Deferred.make<void>();
      let attempts = 0;
      const uploaded = { ...published, id: localId, fileName: "offline-note.txt" };
      const layer = makeLayer(
        makeRpc({
          PrepareSnippetUpload: () => {
            attempts += 1;
            return attempts === 1
              ? Deferred.succeed(firstAttempt, undefined).pipe(
                  Effect.andThen(
                    Effect.fail(
                      new OfflineError({
                        message: "The test client is offline.",
                      }),
                    ),
                  ),
                )
              : Effect.succeed({
                  storageProvider: "GOOGLE_DRIVE",
                  storageObjectId: null,
                  upload: {
                    method: "PUT",
                    url: "https://upload.example",
                    headers: [],
                    strategy: { type: "single_request" },
                  },
                  expiresAt: null,
                });
          },
          PublishSnippet: () => Effect.succeed(uploaded),
        }),
      );

      yield* Effect.gen(function* () {
        const bytes = new TextEncoder().encode("note");
        yield* (yield* UploadEngine).upload(
          {
            id: localId,
            fileName: "offline-note.txt",
            byteSize: bytes.byteLength,
            storageProvider: "GOOGLE_DRIVE",
            mediaType: "text/plain",
          },
          {
            read: (offset, byteSize) => Effect.succeed(bytes.slice(offset, offset + byteSize)),
          },
        );

        yield* Deferred.await(firstAttempt);
        const preparingSnapshot = yield* (yield* SnippetStore).subscribe().pipe(
          Stream.filter((snapshot) =>
            snapshot.some((snippet) => snippet.id === localId && snippet.status === "PREPARING"),
          ),
          Stream.runHead,
        );
        expect(preparingSnapshot).toBeDefined();

        const publishedSnapshot = yield* (yield* SnippetStore).subscribe().pipe(
          Stream.filter((snapshot) =>
            snapshot.some((snippet) => snippet.id === localId && snippet.status === "PUBLISHED"),
          ),
          Stream.runHead,
          Effect.forkChild,
        );
        yield* TestClock.adjust("1 second");
        yield* Fiber.join(publishedSnapshot);

        expect(attempts).toBe(2);
        expect((yield* listSnippets(user.id))[0]).toMatchObject({
          id: localId,
          status: "PUBLISHED",
        });
      }).pipe(Effect.provide(layer));
    }).pipe(Effect.provide(TestClock.layer())),
  );

  it.effect("stops retrying an upload after the retry budget is exhausted", () =>
    Effect.gen(function* () {
      const firstAttempt = yield* Deferred.make<void>();
      let attempts = 0;
      const layer = makeLayer(
        makeRpc({
          PrepareSnippetUpload: () => {
            attempts += 1;
            const attempted =
              attempts === 1 ? Deferred.succeed(firstAttempt, undefined) : Effect.void;
            return attempted.pipe(
              Effect.andThen(
                Effect.fail(
                  new OfflineError({
                    message: "The test client is offline.",
                  }),
                ),
              ),
            );
          },
        }),
      );

      yield* Effect.gen(function* () {
        const bytes = new TextEncoder().encode("note");
        yield* (yield* UploadEngine).upload(
          {
            id: localId,
            fileName: "offline-note.txt",
            byteSize: bytes.byteLength,
            storageProvider: "GOOGLE_DRIVE",
            mediaType: "text/plain",
          },
          {
            read: (offset, byteSize) => Effect.succeed(bytes.slice(offset, offset + byteSize)),
          },
        );

        const failedSnapshot = yield* (yield* SnippetStore).subscribe().pipe(
          Stream.filter((snapshot) =>
            snapshot.some((snippet) => snippet.id === localId && snippet.status === "FAILED"),
          ),
          Stream.runHead,
          Effect.forkChild,
        );
        yield* Deferred.await(firstAttempt);
        yield* TestClock.adjust("31 seconds");
        yield* Fiber.join(failedSnapshot);

        expect(attempts).toBe(6);
        expect((yield* listSnippets(user.id))[0]).toMatchObject({
          id: localId,
          status: "FAILED",
        });
      }).pipe(Effect.provide(layer));
    }).pipe(Effect.provide(TestClock.layer())),
  );

  it.effect("times out stalled transfer attempts and exhausts the retry budget", () =>
    Effect.gen(function* () {
      const firstAttempt = yield* Deferred.make<void>();
      let attempts = 0;
      const layer = makeLayer(
        makeRpc({
          PrepareSnippetUpload: () => {
            attempts += 1;
            return Deferred.succeed(firstAttempt, undefined).pipe(Effect.andThen(Effect.never));
          },
        }),
      );

      yield* Effect.gen(function* () {
        const bytes = new TextEncoder().encode("note");
        yield* (yield* UploadEngine).upload(
          {
            id: localId,
            fileName: "stalled-note.txt",
            byteSize: bytes.byteLength,
            storageProvider: "GOOGLE_DRIVE",
            mediaType: "text/plain",
          },
          {
            read: (offset, byteSize) => Effect.succeed(bytes.slice(offset, offset + byteSize)),
          },
        );

        const failedSnapshot = yield* (yield* SnippetStore).subscribe().pipe(
          Stream.filter((snapshot) =>
            snapshot.some((snippet) => snippet.id === localId && snippet.status === "FAILED"),
          ),
          Stream.runHead,
          Effect.forkChild,
        );
        yield* Deferred.await(firstAttempt);
        yield* TestClock.adjust("13 minutes");
        yield* Fiber.join(failedSnapshot);

        expect(attempts).toBe(6);
      }).pipe(Effect.provide(layer));
    }).pipe(Effect.provide(TestClock.layer())),
  );

  it.effect("allows a healthy transfer to exceed two minutes overall", () =>
    Effect.gen(function* () {
      const uploaded = { ...published, id: localId, fileName: "large-note.txt" };
      const layer = makeLayer(
        makeRpc({
          PrepareSnippetUpload: () =>
            Effect.sleep("90 seconds").pipe(
              Effect.as({
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
            ),
          PublishSnippet: () => Effect.succeed(uploaded),
        }),
        undefined,
        { httpDelayMilliseconds: 90_000 },
      );

      yield* Effect.gen(function* () {
        const bytes = new TextEncoder().encode("note");
        yield* (yield* UploadEngine).upload(
          {
            id: localId,
            fileName: "large-note.txt",
            byteSize: bytes.byteLength,
            storageProvider: "GOOGLE_DRIVE",
            mediaType: "text/plain",
          },
          {
            read: (offset, byteSize) => Effect.succeed(bytes.slice(offset, offset + byteSize)),
          },
        );

        const publishedSnapshot = yield* (yield* SnippetStore).subscribe().pipe(
          Stream.filter((snapshot) =>
            snapshot.some((snippet) => snippet.id === localId && snippet.status === "PUBLISHED"),
          ),
          Stream.runHead,
          Effect.forkChild,
        );
        yield* TestClock.adjust("3 minutes");
        yield* Fiber.join(publishedSnapshot);

        expect((yield* listSnippets(user.id))[0]).toMatchObject({
          id: localId,
          status: "PUBLISHED",
        });
      }).pipe(Effect.provide(layer));
    }).pipe(Effect.provide(TestClock.layer())),
  );

  it.effect("marks an interrupted native upload as failed without discarding its content", () => {
    const bytes = new TextEncoder().encode("note");
    const stored = new Map([[localId, bytes]]);
    const layer = makeLayer(makeRpc(), undefined, { localContent: stored });

    return Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* sql`
        INSERT INTO client_snippets (
          user_id,
          id,
          file_name,
          byte_size,
          storage_provider,
          media_type,
          storage_object_id,
          status,
          error_message,
          created_at,
          updated_at
        )
        VALUES (
          ${user.id},
          ${localId},
          'interrupted-note.txt',
          ${bytes.byteLength},
          'GOOGLE_DRIVE',
          'text/plain',
          NULL,
          'UPLOADING',
          NULL,
          '2026-07-20T19:00:00.000Z',
          '2026-07-20T19:00:00.000Z'
        )
      `;

      yield* (yield* UploadEngine).initialize;
      yield* (yield* ContentMirror).reconcile;

      const snapshot = Option.getOrThrow(
        yield* (yield* SnippetStore).subscribe().pipe(Stream.runHead),
      );
      expect(snapshot[0]).toMatchObject({
        id: localId,
        mediaType: "text/plain",
        status: "FAILED",
        errorMessage: "This upload was interrupted.",
      });
      expect(stored.has(localId)).toBe(true);
    }).pipe(Effect.provide(layer));
  });

  it.effect("rejects multipart progress beyond the bytes just sent", () => {
    let publishedCount = 0;
    const layer = makeLayer(
      makeRpc({
        PrepareSnippetUpload: () =>
          Effect.succeed({
            storageProvider: "GOOGLE_DRIVE",
            storageObjectId: "drive-object",
            upload: {
              method: "PUT",
              url: "https://upload.example",
              headers: [],
              strategy: {
                type: "byte_range",
                maxPartByteSize: 2,
                partByteMultiple: 2,
              },
            },
            expiresAt: null,
          }),
        PublishSnippet: () => {
          publishedCount += 1;
          return Effect.succeed({ ...published, id: localId });
        },
      }),
      () => new Response(null, { status: 308, headers: { range: "bytes=0-3" } }),
    );

    return Effect.gen(function* () {
      const bytes = new TextEncoder().encode("note");
      yield* (yield* UploadEngine).upload(
        {
          id: localId,
          fileName: "note.txt",
          byteSize: bytes.byteLength,
          storageProvider: "GOOGLE_DRIVE",
          mediaType: "text/plain",
        },
        {
          read: (offset, byteSize) => Effect.succeed(bytes.slice(offset, offset + byteSize)),
        },
      );

      yield* (yield* SnippetStore).subscribe().pipe(
        Stream.filter((snapshot) =>
          snapshot.some((snippet) => snippet.id === localId && snippet.status === "FAILED"),
        ),
        Stream.runHead,
      );

      expect(publishedCount).toBe(0);
    }).pipe(Effect.provide(layer));
  });

  it.effect("keeps a temporary download failure available for a later retry", () => {
    const layer = makeLayer(
      makeRpc({
        GetSnippetSnapshot: () => Effect.succeed([published]),
        DownloadSnippetContent: () =>
          Stream.fail(
            new OfflineError({
              message: "The test client is offline.",
            }),
          ),
      }),
    );

    return Effect.gen(function* () {
      yield* (yield* SyncEngine).pull;
      yield* (yield* ContentMirror).download(publishedId).pipe(Effect.flip);

      expect((yield* listSnippets(user.id))[0]).toMatchObject({
        id: publishedId,
        localContentAvailability: { status: "NOT_AVAILABLE" },
      });
    }).pipe(Effect.provide(layer));
  });

  it.effect("persists a terminal provider rejection for manual recovery", () => {
    const layer = makeLayer(
      makeRpc({
        GetSnippetSnapshot: () => Effect.succeed([published]),
        DownloadSnippetContent: () =>
          Stream.fail(
            new RpcError({
              code: "INTERNAL_SERVER_ERROR",
              message: "provider rejected download",
              retryable: false,
            }),
          ),
      }),
    );

    return Effect.gen(function* () {
      yield* (yield* SyncEngine).pull;
      yield* (yield* ContentMirror).download(publishedId).pipe(Effect.flip);

      expect((yield* listSnippets(user.id))[0]).toMatchObject({
        id: publishedId,
        localContentAvailability: { status: "FAILED" },
      });
    }).pipe(Effect.provide(layer));
  });

  it.effect("streams remote content without requiring a local content store", () => {
    const bytes = new TextEncoder().encode("note");
    const layer = makeLayer(
      makeRpc({
        GetSnippetSnapshot: () => Effect.succeed([published]),
        DownloadSnippetContent: () => Stream.succeed(bytes),
      }),
      undefined,
      { localContent: false },
    );

    return Effect.gen(function* () {
      yield* (yield* SyncEngine).pull;
      const content = yield* (yield* ContentMirror).readRemote(publishedId).pipe(
        Stream.runCollect,
        Effect.map((chunks) => Uint8Array.from(chunks.flatMap((chunk) => Array.from(chunk)))),
      );
      expect(content).toEqual(bytes);
    }).pipe(Effect.provide(layer));
  });

  it.effect("rejects remote content that does not match the published byte size", () => {
    const layer = makeLayer(
      makeRpc({
        GetSnippetSnapshot: () => Effect.succeed([published]),
        DownloadSnippetContent: () => Stream.succeed(new Uint8Array([1, 2, 3])),
      }),
      undefined,
      { localContent: false },
    );

    return Effect.gen(function* () {
      yield* (yield* SyncEngine).pull;
      const error = yield* (yield* ContentMirror)
        .readRemote(publishedId)
        .pipe(Stream.runDrain, Effect.flip);
      expect(error).toEqual(
        new DownloadedContentMismatchError({
          snippetId: publishedId,
          expectedByteSize: published.byteSize,
          actualByteSize: 3,
          message: "The downloaded content size does not match the snippet.",
        }),
      );
    }).pipe(Effect.provide(layer));
  });

  it.effect("stops a remote stream that exceeds the published byte size", () => {
    const layer = makeLayer(
      makeRpc({
        GetSnippetSnapshot: () => Effect.succeed([published]),
        DownloadSnippetContent: () => Stream.succeed(new Uint8Array([1, 2, 3, 4, 5])),
      }),
      undefined,
      { localContent: false },
    );

    return Effect.gen(function* () {
      yield* (yield* SyncEngine).pull;
      const error = yield* (yield* ContentMirror)
        .readRemote(publishedId)
        .pipe(Stream.runDrain, Effect.flip);
      expect(error).toEqual(
        new DownloadedContentMismatchError({
          snippetId: publishedId,
          expectedByteSize: published.byteSize,
          actualByteSize: 5,
          message: "The downloaded content size does not match the snippet.",
        }),
      );
    }).pipe(Effect.provide(layer));
  });

  it.effect("keeps the newest twenty eligible snippets available locally", () => {
    const snippets = Array.from(
      { length: 21 },
      (_, index): ApiSnippet => ({
        id: `00000000-0000-4000-8000-${String(index).padStart(12, "0")}`,
        fileName: `${index}.txt`,
        byteSize: 1,
        storageProvider: "GOOGLE_DRIVE",
        storageObjectId: `object-${index}`,
        createdAt: `2026-07-20T20:00:${String(index).padStart(2, "0")}.000Z`,
        updatedAt: `2026-07-20T20:00:${String(index).padStart(2, "0")}.000Z`,
      }),
    );
    const layer = makeLayer(
      makeRpc({
        GetSnippetSnapshot: () => Effect.succeed(snippets),
        DownloadSnippetContent: () => Stream.succeed(new Uint8Array([1])),
      }),
    );

    return Effect.gen(function* () {
      yield* (yield* SyncEngine).pull;
      yield* (yield* ContentMirror).reconcile;

      const sql = yield* SqlClient.SqlClient;
      const rows = yield* sql<{ readonly status: string; readonly count: number }>`
          SELECT status, COUNT(*) AS count
          FROM client_local_files
          WHERE user_id = ${user.id}
          GROUP BY status
          ORDER BY status
        `;
      expect(rows).toEqual([
        { status: "AVAILABLE", count: 20 },
        { status: "NOT_AVAILABLE", count: 1 },
      ]);
    }).pipe(Effect.provide(layer));
  });
});
