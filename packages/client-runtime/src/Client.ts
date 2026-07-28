import type { PrepareSnippetUploadPayload } from "@plakk/shared/PlakkApi";
import { Cause, Context, Effect, Layer, Schedule, Stream } from "effect";

import type { LocalStorageError } from "./models/ClientError.ts";
import { isPublishedSnippet, type Snippet } from "./models/Snippet.ts";
import { RpcClient } from "./RpcClient.ts";
import {
  ContentMirror,
  type ContentMirrorFailure,
  type FreeUpSpaceResult,
} from "./snippets/ContentMirror.ts";
import { SnippetStore } from "./snippets/SnippetStore.ts";
import { SyncEngine, type SyncFailure } from "./snippets/SyncEngine.ts";
import {
  UploadEngine,
  type UploadFailure,
  type UploadSource,
  UploadSourceUnavailableError,
} from "./snippets/UploadEngine.ts";
import { runMigrations } from "./sqlite/Migrations.ts";

export type ClientError = ContentMirrorFailure | LocalStorageError | SyncFailure | UploadFailure;

export class Client extends Context.Service<
  Client,
  {
    readonly content: {
      /** Downloads and stores one published snippet on this device. */
      readonly download: (snippetId: string) => Effect.Effect<void, ClientError>;
      /** Streams locally stored content for one snippet. */
      readonly read: (snippetId: string) => Stream.Stream<Uint8Array, ClientError>;
      /** Removes local copies outside the automatically maintained set. */
      readonly freeUp: Effect.Effect<FreeUpSpaceResult, ClientError>;
    };
    readonly snippets: {
      /**
       * Subscribes to the current user's complete local snippet snapshots.
       *
       * The current SQLite state is emitted immediately, followed by every
       * committed change made by uploads or synchronization.
       */
      readonly subscribe: () => Stream.Stream<ReadonlyArray<Snippet>, ClientError>;
      /** Deletes a published snippet remotely and then removes its local state. */
      readonly delete: (snippetId: string) => Effect.Effect<void, ClientError>;
      /** Permanently removes a failed local upload after the user dismisses it. */
      readonly dismissFailedUpload: (snippetId: string) => Effect.Effect<void, ClientError>;
    };
    readonly uploads: {
      /**
       * Persists one snippet and starts its managed background upload.
       *
       * Platform code only supplies metadata and a range-readable source. The
       * effect completes once the source is safe to release. Publication or
       * failure is reported through `snippets.subscribe()`.
       */
      readonly upload: <E>(
        input: PrepareSnippetUploadPayload,
        source: UploadSource<E>,
      ) => Effect.Effect<void, ClientError>;
    };
  }
>()("@plakk/client-runtime/Client") {}

/** Implements the Client façade using focused runtime modules. */
export const clientLive = Layer.effect(
  Client,
  Effect.gen(function* () {
    const snippets = yield* SnippetStore;
    const sync = yield* SyncEngine;
    const uploads = yield* UploadEngine;
    const content = yield* ContentMirror;

    yield* runMigrations();
    yield* uploads.initialize;
    yield* snippets.subscribe().pipe(
      Stream.map((snapshot) =>
        snapshot
          .filter(isPublishedSnippet)
          .map((snippet) => `${snippet.id}:${snippet.updatedAt}:${snippet.byteSize}`)
          .join("|"),
      ),
      Stream.changes,
      Stream.runForEach(() =>
        content.reconcile.pipe(
          Effect.catchCause((cause) =>
            Effect.logWarning("Local content reconciliation failed", {
              cause: Cause.pretty(cause),
            }),
          ),
        ),
      ),
      Effect.catchCause((cause) =>
        Effect.logWarning("Local content reconciliation stopped", {
          cause: Cause.pretty(cause),
        }),
      ),
      Effect.forkScoped,
    );
    yield* content.reconcile.pipe(
      Effect.catchCause((cause) =>
        Effect.logWarning("Periodic local content reconciliation failed", {
          cause: Cause.pretty(cause),
        }),
      ),
      Effect.repeat(Schedule.spaced("30 seconds")),
      Effect.forkScoped,
    );
    yield* sync.run.pipe(Effect.forkScoped);

    /** Exposes the local snippet snapshots maintained by the runtime. */
    const subscribe = (): Stream.Stream<ReadonlyArray<Snippet>, ClientError> =>
      snippets.subscribe();

    /** Runs the complete remote-first snippet deletion procedure. */
    const deleteSnippet = Effect.fn("Client.snippets.delete")(function* (snippetId: string) {
      yield* sync.delete(snippetId);
    });

    /** Runs the complete failed-upload dismissal procedure. */
    const dismissFailedUpload = Effect.fn("Client.snippets.dismissFailedUpload")(function* (
      snippetId: string,
    ) {
      yield* uploads.discard(snippetId);
    });

    /**
     * Runs the complete upload while converting platform source failures
     * before they enter the engine's typed failure channel.
     */
    const upload: Client["Service"]["uploads"]["upload"] = Effect.fn("Client.uploads.upload")(
      function* <E>(input: PrepareSnippetUploadPayload, source: UploadSource<E>) {
        const safeSource: UploadSource<UploadSourceUnavailableError> = {
          read: (offset, byteSize) =>
            source.read(offset, byteSize).pipe(
              Effect.mapError(
                () =>
                  new UploadSourceUnavailableError({
                    message: "Plakk could not read the selected file.",
                  }),
              ),
            ),
        };
        yield* uploads.upload(input, safeSource);
      },
    );

    return Client.of({
      content: {
        download: content.download,
        read: content.read,
        freeUp: content.freeUp,
      },
      snippets: {
        subscribe,
        delete: deleteSnippet,
        dismissFailedUpload,
      },
      uploads: { upload },
    });
  }),
);

const snippetsLayer = SnippetStore.Live;
const rpcLayer = RpcClient.Live;
const engineDependencies = Layer.merge(snippetsLayer, rpcLayer);
const enginesLayer = Layer.mergeAll(ContentMirror.Live, SyncEngine.Live, UploadEngine.Live).pipe(
  Layer.provideMerge(engineDependencies),
);

/**
 * Builds the complete shared client from standard platform capabilities.
 *
 * Platforms provide `SqlClient`, `HttpClient`, the RPC protocol, and
 * `CurrentSession`. Providing `ContentStore` enables native content mirroring;
 * omitting it leaves uploads remote-only. This layer owns all focused-module
 * wiring and exposes only the `Client` façade.
 */
export const clientLayer = clientLive.pipe(Layer.provide(enginesLayer));
