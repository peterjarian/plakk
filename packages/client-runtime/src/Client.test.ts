import { SqliteClient } from "@effect/sql-sqlite-node";
import { describe, expect, it } from "@effect/vitest";
import type { User } from "@plakk/shared";
import { SessionError } from "@plakk/shared/PlakkApi";
import { DateTime, Effect, Layer, Option, Stream } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { Client, clientLive } from "./Client.ts";
import { CurrentSession } from "./CurrentSession.ts";
import { RpcClient } from "./RpcClient.ts";
import { ContentMirror, ContentStore } from "./snippets/ContentMirror.ts";
import { SnippetStore } from "./snippets/SnippetStore.ts";
import { SyncEngine } from "./snippets/SyncEngine.ts";
import { UploadEngine, UploadSourceUnavailableError } from "./snippets/UploadEngine.ts";

const snippetId = "0d1e2f3a-4567-4890-8abc-def012345678";
const user: User = {
  id: "user-1",
  firstName: "Test",
  lastName: "User",
  email: "test@example.com",
  createdAt: "2026-07-20T18:00:00.000Z",
  updatedAt: "2026-07-20T18:00:00.000Z",
};

const makeLayer = (options?: {
  readonly deleteError?: SessionError;
  readonly events?: Array<string>;
}) => {
  const events = options?.events ?? [];
  const upload: UploadEngine["Service"]["upload"] = (input, source) =>
    source.read(0, input.byteSize).pipe(
      Effect.tap(() => Effect.sync(() => events.push("upload"))),
      Effect.asVoid,
    );

  return clientLive.pipe(
    Layer.provideMerge(
      Layer.mergeAll(
        SqliteClient.layer({ filename: ":memory:" }),
        Layer.succeed(
          CurrentSession,
          CurrentSession.of({ user, accessToken: Effect.succeed("token") }),
        ),
        Layer.succeed(
          RpcClient,
          RpcClient.of({
            BeginStorageProviderLink: ({
              storageProvider,
            }: Parameters<RpcClient["Service"]["BeginStorageProviderLink"]>[0]) =>
              Effect.succeed({
                url: `https://connect.example/${storageProvider.toLowerCase()}`,
              }),
            OpenBilling: () => Effect.succeed({ url: "https://checkout.example" }),
            GetAccountStatus: () =>
              Effect.succeed({
                canSync: true,
                storageProvider: "GOOGLE_DRIVE",
                blockedReasons: [],
                billing: {
                  status: "FREE_PERIOD",
                  freeUntil: DateTime.makeUnsafe("2099-01-01T00:00:00.000Z"),
                },
              }),
            GetStorageProviderStatus: () =>
              Effect.succeed({
                storageProvider: "GOOGLE_DRIVE",
                status: "CONNECTED",
                externalDestinationUrl: "https://drive.google.com/drive/folders/plakk",
              }),
          } as unknown as RpcClient["Service"]),
        ),
        Layer.succeed(
          ContentMirror,
          ContentMirror.of({
            reconcile: Effect.void,
            download: (id) =>
              Effect.sync(() => {
                events.push(`download:${id}`);
              }),
            freeUp: Effect.sync(() => {
              events.push("freeUp");
              return {
                reclaimedBytes: 0,
                removedCopies: 0,
                storageUsageBytes: 0,
              };
            }),
            read: (id) =>
              Stream.fromEffect(
                Effect.sync(() => {
                  events.push(`read:${id}`);
                  return new Uint8Array([1, 2, 3, 4]);
                }),
              ),
            readRemote: (id) =>
              Stream.fromEffect(
                Effect.sync(() => {
                  events.push(`readRemote:${id}`);
                  return new Uint8Array([1, 2, 3, 4]);
                }),
              ),
          }),
        ),
        Layer.succeed(
          ContentStore,
          ContentStore.of({
            entries: Effect.succeed([{ snippetId, byteSize: 4 }]),
            write: () => Effect.void,
            read: () => Stream.empty,
            readRange: () => Effect.succeed(new Uint8Array()),
            remove: (ids) =>
              Effect.sync(() => {
                events.push(`clear:${ids.join(",")}`);
              }),
          }),
        ),
        Layer.succeed(
          SnippetStore,
          SnippetStore.of({
            subscribe: () => Stream.make([]),
            refresh: Effect.void,
          }),
        ),
        Layer.succeed(
          SyncEngine,
          SyncEngine.of({
            pull: Effect.void,
            run: Effect.sync(() => events.push("sync")).pipe(Effect.andThen(Effect.never)),
            subscribe: () => Stream.make("CONNECTED"),
            delete: (id) =>
              options?.deleteError === undefined
                ? Effect.sync(() => {
                    events.push(`delete:${id}`);
                  })
                : Effect.fail(options.deleteError),
          }),
        ),
        Layer.succeed(
          UploadEngine,
          UploadEngine.of({
            upload,
            initialize: Effect.sync(() => {
              events.push("initialize");
            }),
            discard: (id) =>
              Effect.sync(() => {
                events.push(`dismiss:${id}`);
              }),
          }),
        ),
      ),
    ),
  );
};

describe("Client", () => {
  it.effect("initializes once and exposes complete user-intent operations", () => {
    const events: Array<string> = [];

    return Effect.gen(function* () {
      const client = yield* Client;
      yield* Effect.yieldNow;

      expect(events.slice(0, 2)).toEqual(["initialize", "sync"]);
      const initial = Option.getOrThrow(yield* client.subscribe().pipe(Stream.runHead));
      expect(initial.snippets).toEqual([]);
      expect(initial.syncStatus).toBe("CONNECTED");
      yield* client.refresh;
      expect(Option.getOrThrow(yield* client.subscribe().pipe(Stream.runHead)).capability).toEqual({
        status: "ONLINE",
        account: {
          canSync: true,
          storageProvider: "GOOGLE_DRIVE",
          blockedReasons: [],
          billing: {
            status: "FREE_PERIOD",
            freeUntil: DateTime.makeUnsafe("2099-01-01T00:00:00.000Z"),
          },
        },
        connection: {
          storageProvider: "GOOGLE_DRIVE",
          status: "CONNECTED",
          externalDestinationUrl: "https://drive.google.com/drive/folders/plakk",
        },
      });
      expect(yield* client.storage.beginLink("DROPBOX")).toBe("https://connect.example/dropbox");
      expect(yield* client.billing.open("DESKTOP")).toBe("https://checkout.example");

      yield* client.uploads.upload(
        {
          id: snippetId,
          fileName: "note.txt",
          byteSize: 4,
          storageProvider: "GOOGLE_DRIVE",
          mediaType: "text/plain",
        },
        {
          read: () => Effect.succeed(new Uint8Array([1, 2, 3, 4])),
        },
      );
      yield* client.snippets.delete(snippetId);
      yield* client.snippets.dismissFailedUpload(snippetId);
      yield* client.content.download(snippetId);
      yield* client.content.read(snippetId).pipe(Stream.runDrain);
      yield* client.content.readRemote(snippetId).pipe(Stream.runDrain);
      yield* client.content.freeUp;

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
          ${snippetId},
          'failed.txt',
          4,
          'GOOGLE_DRIVE',
          'text/plain',
          NULL,
          'FAILED',
          'Upload failed.',
          '2026-07-20T19:00:00.000Z',
          '2026-07-20T19:00:00.000Z'
        )
      `;
      yield* client.clearLocalData;
      const remaining = yield* sql<{ readonly count: number }>`
        SELECT COUNT(*) AS count
        FROM client_snippets
        WHERE user_id = ${user.id}
      `;
      expect(remaining).toEqual([{ count: 0 }]);

      expect(events).toEqual([
        "initialize",
        "sync",
        "upload",
        `delete:${snippetId}`,
        `dismiss:${snippetId}`,
        `download:${snippetId}`,
        `read:${snippetId}`,
        `readRemote:${snippetId}`,
        "freeUp",
        `clear:${snippetId}`,
      ]);
    }).pipe(Effect.provide(makeLayer({ events })));
  });

  it.effect("passes safe typed errors to the platform", () =>
    Effect.gen(function* () {
      const client = yield* Client;
      const sourceError = yield* client.uploads
        .upload(
          {
            id: snippetId,
            fileName: "note.txt",
            byteSize: 4,
            storageProvider: "GOOGLE_DRIVE",
            mediaType: "text/plain",
          },
          {
            read: () => Effect.fail("native read failure"),
          },
        )
        .pipe(Effect.flip);
      expect(sourceError).toEqual(
        new UploadSourceUnavailableError({
          message: "Plakk could not read the selected file.",
        }),
      );

      const sessionError = yield* client.snippets.delete(snippetId).pipe(Effect.flip);
      expect(sessionError).toEqual(
        new SessionError({
          message: "Your session expired. Sign in again to continue.",
        }),
      );
    }).pipe(
      Effect.provide(
        makeLayer({
          deleteError: new SessionError({
            message: "Your session expired. Sign in again to continue.",
          }),
        }),
      ),
    ),
  );
});
