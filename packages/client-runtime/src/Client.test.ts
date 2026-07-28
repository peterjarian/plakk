import { SqliteClient } from "@effect/sql-sqlite-node";
import { describe, expect, it } from "@effect/vitest";
import { SessionError } from "@plakk/shared/PlakkApi";
import { Effect, Layer, Option, Stream } from "effect";

import { Client, clientLive } from "./Client.ts";
import { ContentMirror } from "./snippets/ContentMirror.ts";
import { SnippetStore } from "./snippets/SnippetStore.ts";
import { SyncEngine } from "./snippets/SyncEngine.ts";
import { UploadEngine, UploadSourceUnavailableError } from "./snippets/UploadEngine.ts";

const snippetId = "0d1e2f3a-4567-4890-8abc-def012345678";

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
    Layer.provide(
      Layer.mergeAll(
        SqliteClient.layer({ filename: ":memory:" }),
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
      const initial = yield* client.snippets.subscribe().pipe(Stream.runHead);
      expect(Option.getOrThrow(initial)).toEqual([]);

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
      yield* client.content.freeUp;

      expect(events).toEqual([
        "initialize",
        "sync",
        "upload",
        `delete:${snippetId}`,
        `dismiss:${snippetId}`,
        `download:${snippetId}`,
        `read:${snippetId}`,
        "freeUp",
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
