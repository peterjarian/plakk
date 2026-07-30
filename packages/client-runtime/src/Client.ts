import { type StorageProvider, UserSchema } from "@plakk/shared";
import type { PrepareSnippetUploadPayload } from "@plakk/shared/PlakkApi";
import {
  ClientCapabilitySchema,
  type ClientCapability as SharedClientCapability,
  OfflineError,
  SessionError,
} from "@plakk/shared/PlakkApi";
import {
  Cause,
  Context,
  Effect,
  Fiber,
  Layer,
  Option,
  Schedule,
  Schema,
  Stream,
  SubscriptionRef,
} from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { CurrentSession } from "./CurrentSession.ts";
import {
  ActionNotAllowedError,
  InvalidResponseError,
  LocalStorageError,
  ServerUnavailableError,
} from "./models/ClientError.ts";
import { isPublishedSnippet, SnippetSchema } from "./models/Snippet.ts";
import { RpcClient } from "./RpcClient.ts";
import {
  ContentMirror,
  ContentStore,
  type ContentMirrorFailure,
  type FreeUpSpaceResult,
} from "./snippets/ContentMirror.ts";
import { SnippetStore } from "./snippets/SnippetStore.ts";
import { SyncEngine, type SyncFailure, SyncStatusSchema } from "./snippets/SyncEngine.ts";
import {
  UploadEngine,
  type UploadFailure,
  type UploadSource,
  UploadSourceUnavailableError,
} from "./snippets/UploadEngine.ts";
import { clientDatabaseLayer, runMigrations } from "./sqlite/Migrations.ts";
import { clearAccount, getStorageProvider, setStorageProvider } from "./sqlite/queries/account.ts";
import { clearSnippets } from "./sqlite/queries/snippets.ts";

export type ClientError = ContentMirrorFailure | LocalStorageError | SyncFailure | UploadFailure;

export type ClientCapability = SharedClientCapability;

export const ClientSnapshotSchema = Schema.Struct({
  user: UserSchema,
  capability: ClientCapabilitySchema,
  syncStatus: SyncStatusSchema,
  storageUsageBytes: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  snippets: Schema.Array(SnippetSchema),
});

export type ClientSnapshot = typeof ClientSnapshotSchema.Type;

export class Client extends Context.Service<
  Client,
  {
    /**
     * Subscribes to the complete current-user state owned by the client.
     *
     * The current SQLite-backed state is emitted immediately. Platforms can
     * project this snapshot for their own process or UI transport.
     */
    readonly subscribe: () => Stream.Stream<ClientSnapshot, ClientError>;
    /** Refreshes account and storage-provider capability from the backend. */
    readonly refresh: Effect.Effect<void, ClientError>;
    /** Removes all snippet records and managed content owned by the current user. */
    readonly clearLocalData: Effect.Effect<void, ClientError>;
    readonly billing: {
      /** Opens either Polar Checkout or the authenticated customer portal. */
      readonly open: Effect.Effect<string, ClientError>;
    };
    readonly storage: {
      /** Starts the provider-owned authorization flow and returns its destination URL. */
      readonly beginLink: (storageProvider: StorageProvider) => Effect.Effect<string, ClientError>;
    };
    readonly content: {
      /** Downloads and stores one published snippet on this device. */
      readonly download: (snippetId: string) => Effect.Effect<void, ClientError>;
      /** Streams locally stored content for one snippet. */
      readonly read: (snippetId: string) => Stream.Stream<Uint8Array, ClientError>;
      /** Streams published content without retaining a device-local copy. */
      readonly readRemote: (snippetId: string) => Stream.Stream<Uint8Array, ClientError>;
      /** Removes local copies outside the automatically maintained set. */
      readonly freeUp: Effect.Effect<FreeUpSpaceResult, ClientError>;
    };
    readonly snippets: {
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
       * failure is reported through `subscribe()`.
       */
      readonly upload: <E>(
        input: PrepareSnippetUploadPayload,
        source: UploadSource<E>,
      ) => Effect.Effect<void, ClientError>;
    };
  }
>()("@plakk/client-runtime/Client") {}

const clearMetadataRows = (userId: string) =>
  Effect.gen(function* () {
    yield* clearAccount(userId);
    yield* clearSnippets(userId);
  });

/** Opens the client schema if needed and removes one user's persisted metadata. */
export const clearClientMetadata = Effect.fn("Client.clearClientMetadata")(
  function* (userId: string) {
    yield* runMigrations();
    yield* clearMetadataRows(userId);
  },
  Effect.catchTags({
    SqlError: () =>
      Effect.fail(
        new LocalStorageError({
          message: "Plakk could not remove its local snippet data.",
        }),
      ),
  }),
);

/** Implements the Client façade using focused runtime modules. */
export const clientLive = Layer.effect(
  Client,
  Effect.gen(function* () {
    const snippets = yield* SnippetStore;
    const sync = yield* SyncEngine;
    const uploads = yield* UploadEngine;
    const content = yield* ContentMirror;
    const contentStore = Option.getOrUndefined(yield* Effect.serviceOption(ContentStore));
    const session = yield* CurrentSession;
    const rpc = yield* RpcClient;
    const sql = yield* SqlClient.SqlClient;

    yield* runMigrations();
    const cachedStorageProvider = yield* getStorageProvider(session.user.id).pipe(
      Effect.provideService(SqlClient.SqlClient, sql),
      Effect.catchTags({
        SchemaError: () =>
          Effect.fail(
            new LocalStorageError({
              message: "Plakk could not read its local account state.",
            }),
          ),
        SqlError: () =>
          Effect.fail(
            new LocalStorageError({
              message: "Plakk could not read its local account state.",
            }),
          ),
      }),
    );
    const capability = yield* SubscriptionRef.make<ClientCapability>({
      status: "OFFLINE",
      storageProvider: cachedStorageProvider,
    });
    yield* uploads.initialize;
    const contentReconcileFiber = yield* snippets.subscribe().pipe(
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
    const periodicContentReconcileFiber = yield* content.reconcile.pipe(
      Effect.catchCause((cause) =>
        Effect.logWarning("Periodic local content reconciliation failed", {
          cause: Cause.pretty(cause),
        }),
      ),
      Effect.repeat(Schedule.spaced("30 seconds")),
      Effect.forkScoped,
    );
    const syncFiber = yield* sync.run.pipe(Effect.forkScoped);

    /** Refreshes account capability and retains the provider for offline display. */
    const refresh = Effect.gen(function* () {
      const account = yield* rpc.GetAccountStatus(undefined);
      const connection =
        account.storageProvider === null
          ? null
          : yield* rpc.GetStorageProviderStatus({ storageProvider: account.storageProvider });
      yield* setStorageProvider(
        session.user.id,
        connection?.status === "NOT_CONNECTED" ? null : account.storageProvider,
      );
      yield* SubscriptionRef.set(capability, {
        status: "ONLINE",
        account,
        connection,
      });
    }).pipe(
      Effect.provideService(SqlClient.SqlClient, sql),
      Effect.catchTags({
        RpcClientError: (error) =>
          error.reason._tag === "RpcClientDefect"
            ? Effect.fail(
                new InvalidResponseError({
                  message: "Plakk received an unexpected account response.",
                }),
              )
            : Effect.fail(
                new OfflineError({
                  message: "Plakk could not connect. Your local snippets remain available.",
                }),
              ),
        RpcError: (error) => {
          switch (error.code) {
            case "UNAUTHENTICATED":
              return Effect.fail(
                new SessionError({
                  message: "Your session expired. Sign in again to continue.",
                }),
              );
            case "FORBIDDEN":
              return Effect.fail(
                new ActionNotAllowedError({
                  message: "You do not have permission to access this account.",
                }),
              );
            case "NOT_FOUND":
            case "CONFLICT":
            case "INTERNAL_SERVER_ERROR":
              return Effect.fail(
                new ServerUnavailableError({
                  message: "Plakk could not load your account. Please try again.",
                }),
              );
          }
        },
        SqlError: () =>
          Effect.fail(
            new LocalStorageError({
              message: "Plakk could not save its local account state.",
            }),
          ),
      }),
      Effect.tapError(() =>
        SubscriptionRef.update(
          capability,
          (current): ClientCapability => ({
            status: "OFFLINE",
            storageProvider:
              current.status === "ONLINE"
                ? {
                    known: true,
                    value:
                      current.connection?.status === "NOT_CONNECTED"
                        ? null
                        : current.account.storageProvider,
                  }
                : current.storageProvider,
          }),
        ),
      ),
      Effect.withSpan("Client.refresh"),
    );

    /** Exposes one cohesive snapshot instead of separate platform-owned stores. */
    const subscribe = (): Stream.Stream<ClientSnapshot, ClientError> =>
      Stream.zipLatest(
        Stream.zipLatest(snippets.subscribe(), sync.subscribe()),
        SubscriptionRef.changes(capability),
      ).pipe(
        Stream.map(([[snapshot, syncStatus], currentCapability]) => ({
          user: session.user,
          capability: currentCapability,
          syncStatus,
          storageUsageBytes: snapshot.reduce(
            (total, snippet) =>
              snippet.localContentAvailability.status === "AVAILABLE"
                ? total + snippet.byteSize
                : total,
            0,
          ),
          snippets: snapshot,
        })),
      );

    const capabilityRefreshFiber = yield* sync.subscribe().pipe(
      Stream.filter((status) => status === "CONNECTED"),
      Stream.runForEach(() =>
        refresh.pipe(
          Effect.catchCause((cause) =>
            Effect.logWarning("Account capability refresh failed", {
              cause: Cause.pretty(cause),
            }),
          ),
        ),
      ),
      Effect.forkScoped,
    );

    const beginStorageLink = Effect.fn("Client.storage.beginLink")(function* (
      storageProvider: StorageProvider,
    ) {
      return yield* rpc.BeginStorageProviderLink({ storageProvider }).pipe(
        Effect.map((result) => result.url),
        Effect.catchTags({
          SessionError: (error) => Effect.fail(error),
          OfflineError: (error) => Effect.fail(error),
          RpcClientError: (error) =>
            error.reason._tag === "RpcClientDefect"
              ? Effect.fail(
                  new InvalidResponseError({
                    message: "Plakk received an unexpected storage response.",
                  }),
                )
              : Effect.fail(
                  new OfflineError({
                    message: "Plakk could not connect. Check your connection and try again.",
                  }),
                ),
          RpcError: (error) =>
            error.code === "UNAUTHENTICATED"
              ? Effect.fail(
                  new SessionError({
                    message: "Your session expired. Sign in again to continue.",
                  }),
                )
              : error.code === "FORBIDDEN"
                ? Effect.fail(
                    new ActionNotAllowedError({
                      message: "You do not have permission to connect this storage provider.",
                    }),
                  )
                : Effect.fail(
                    new ServerUnavailableError({
                      message: "Plakk could not start storage setup. Please try again.",
                    }),
                  ),
        }),
      );
    });

    const openBilling = rpc.OpenBilling(undefined).pipe(
      Effect.map((result) => result.url),
      Effect.catchTags({
        SessionError: (error) => Effect.fail(error),
        OfflineError: (error) => Effect.fail(error),
        RpcClientError: (error) =>
          error.reason._tag === "RpcClientDefect"
            ? Effect.fail(
                new InvalidResponseError({
                  message: "Plakk received an unexpected billing response.",
                }),
              )
            : Effect.fail(
                new OfflineError({
                  message: "Plakk could not connect. Check your connection and try again.",
                }),
              ),
        RpcError: (error) =>
          error.code === "UNAUTHENTICATED"
            ? Effect.fail(
                new SessionError({
                  message: "Your session expired. Sign in again to continue.",
                }),
              )
            : error.code === "FORBIDDEN"
              ? Effect.fail(
                  new ActionNotAllowedError({
                    message: error.message,
                  }),
                )
              : Effect.fail(
                  new ServerUnavailableError({
                    message: "Plakk could not open billing. Please try again.",
                  }),
                ),
      }),
      Effect.withSpan("Client.billing.open"),
    );

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

    /** Removes all local snippet state after the platform has revoked commands. */
    const clearLocalData = Effect.gen(function* () {
      yield* Fiber.interruptAll([
        contentReconcileFiber,
        periodicContentReconcileFiber,
        syncFiber,
        capabilityRefreshFiber,
      ]);
      if (contentStore !== undefined) {
        const entries = yield* contentStore.entries;
        yield* contentStore.remove(entries.map((entry) => entry.snippetId));
      }
      yield* clearMetadataRows(session.user.id);
      yield* snippets.refresh;
    }).pipe(
      Effect.provideService(SqlClient.SqlClient, sql),
      Effect.catchTags({
        SqlError: () =>
          Effect.fail(
            new LocalStorageError({
              message: "Plakk could not remove its local snippet data.",
            }),
          ),
      }),
      Effect.withSpan("Client.clearLocalData"),
    );

    return Client.of({
      subscribe,
      refresh,
      clearLocalData,
      billing: { open: openBilling },
      storage: { beginLink: beginStorageLink },
      content: {
        download: content.download,
        read: content.read,
        readRemote: content.readRemote,
        freeUp: content.freeUp,
      },
      snippets: {
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
export const clientLayer = clientLive.pipe(
  Layer.provide(enginesLayer),
  Layer.provide(clientDatabaseLayer),
);
