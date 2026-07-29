import type { RpcError } from "@plakk/shared/RpcError";
import { OfflineError, SessionError } from "@plakk/shared/PlakkApi";
import { Context, Effect, Layer, Option, Schema, Semaphore, Stream } from "effect";
import { HttpClient, type HttpClientError, HttpClientRequest } from "effect/unstable/http";
import type { RpcClientError } from "effect/unstable/rpc/RpcClientError";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { CurrentSession } from "../CurrentSession.ts";
import {
  ActionNotAllowedError,
  InvalidResponseError,
  LocalStorageError,
  ServerUnavailableError,
  SnippetConflictError,
  SnippetNotFoundError,
} from "../models/ClientError.ts";
import { RpcClient } from "../RpcClient.ts";
import { isPublishedSnippet, type PublishedSnippet } from "../models/Snippet.ts";
import { listPublishedSnippets, setContentStatus } from "../sqlite/queries/content.ts";
import { listSnippets } from "../sqlite/queries/snippets.ts";
import { SnippetStore } from "./SnippetStore.ts";

export const AUTOMATIC_CONTENT_LIMIT = 20;
export const AUTOMATIC_CONTENT_MAX_BYTES = 1024 * 1024 * 1024;

/** Selects the published snippets eligible for automatic local mirroring. */
const automaticSnippets = <A extends { readonly byteSize: number }>(
  snippets: ReadonlyArray<A>,
): ReadonlyArray<A> =>
  snippets
    .filter((snippet) => snippet.byteSize < AUTOMATIC_CONTENT_MAX_BYTES)
    .slice(0, AUTOMATIC_CONTENT_LIMIT);

export const ContentEntrySchema = Schema.Struct({
  snippetId: Schema.String,
  byteSize: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
});

export type ContentEntry = typeof ContentEntrySchema.Type;

export class ContentStore extends Context.Service<
  ContentStore,
  {
    /** Lists complete snippet content currently managed by this device. */
    readonly entries: Effect.Effect<ReadonlyArray<ContentEntry>, LocalStorageError>;
    /** Atomically stores complete snippet content from a byte stream. */
    readonly write: <E>(
      snippetId: string,
      expectedByteSize: number,
      source: Stream.Stream<Uint8Array, E>,
    ) => Effect.Effect<void, E | LocalStorageError>;
    /** Streams complete locally managed content for one snippet. */
    readonly read: (snippetId: string) => Stream.Stream<Uint8Array, LocalStorageError>;
    /** Reads one exact byte range from locally managed content. */
    readonly readRange: (
      snippetId: string,
      offset: number,
      byteSize: number,
    ) => Effect.Effect<Uint8Array, LocalStorageError>;
    /** Removes locally managed content without deleting snippet records. */
    readonly remove: (snippetIds: ReadonlyArray<string>) => Effect.Effect<void, LocalStorageError>;
  }
>()("@plakk/client-runtime/snippets/ContentMirror/ContentStore") {}

export class SnippetNotPublishedError extends Schema.TaggedErrorClass<SnippetNotPublishedError>()(
  "SnippetNotPublishedError",
  {
    snippetId: Schema.String,
    message: Schema.String,
  },
) {}

export class PreparedDownloadMismatchError extends Schema.TaggedErrorClass<PreparedDownloadMismatchError>()(
  "PreparedDownloadMismatchError",
  {
    snippetId: Schema.String,
    message: Schema.String,
  },
) {}

export class DownloadRejectedError extends Schema.TaggedErrorClass<DownloadRejectedError>()(
  "DownloadRejectedError",
  {
    status: Schema.Int,
    message: Schema.String,
  },
) {}

export class DownloadedContentMismatchError extends Schema.TaggedErrorClass<DownloadedContentMismatchError>()(
  "DownloadedContentMismatchError",
  {
    snippetId: Schema.String,
    expectedByteSize: Schema.Int,
    actualByteSize: Schema.Int,
    message: Schema.String,
  },
) {}

export type ContentMirrorFailure =
  | ActionNotAllowedError
  | DownloadRejectedError
  | DownloadedContentMismatchError
  | InvalidResponseError
  | LocalStorageError
  | OfflineError
  | PreparedDownloadMismatchError
  | ServerUnavailableError
  | SessionError
  | SnippetConflictError
  | SnippetNotFoundError
  | SnippetNotPublishedError;

export const FreeUpSpaceResultSchema = Schema.Struct({
  reclaimedBytes: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  removedCopies: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  storageUsageBytes: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
});

export type FreeUpSpaceResult = typeof FreeUpSpaceResultSchema.Type;

export class ContentMirror extends Context.Service<
  ContentMirror,
  {
    /** Repairs local availability and downloads the automatic newest-twenty set. */
    readonly reconcile: Effect.Effect<void, ContentMirrorFailure>;
    /** Downloads and atomically stores one published snippet. */
    readonly download: (snippetId: string) => Effect.Effect<void, ContentMirrorFailure>;
    /** Removes managed content outside the automatic newest-twenty set. */
    readonly freeUp: Effect.Effect<FreeUpSpaceResult, ContentMirrorFailure>;
    /** Streams one published snippet directly from its storage provider. */
    readonly readRemote: (snippetId: string) => Stream.Stream<Uint8Array, ContentMirrorFailure>;
    /** Streams locally managed bytes for one snippet. */
    readonly read: (snippetId: string) => Stream.Stream<Uint8Array, LocalStorageError>;
  }
>()("@plakk/client-runtime/snippets/ContentMirror") {
  static readonly Live = Layer.effect(
    ContentMirror,
    Effect.gen(function* () {
      const session = yield* CurrentSession;
      const rpc = yield* RpcClient;
      const http = yield* HttpClient.HttpClient;
      const content = Option.getOrUndefined(yield* Effect.serviceOption(ContentStore));
      const sql = yield* SqlClient.SqlClient;
      const snippets = yield* SnippetStore;
      const concurrency = yield* Semaphore.make(2);
      const active = new Set<string>();
      const automaticAttempts = new Set<string>();

      /** Creates the safe failure used when this platform has no local content store. */
      const contentUnavailable = (): LocalStorageError =>
        new LocalStorageError({
          message: "Local content storage is not available on this platform.",
        });

      /** Converts a backend-declared failure into a safe runtime error. */
      const rpcFailure = (error: RpcError): ContentMirrorFailure => {
        switch (error.code) {
          case "UNAUTHENTICATED":
            return new SessionError({
              message: "Your session expired. Sign in again to continue.",
            });
          case "FORBIDDEN":
            return new ActionNotAllowedError({
              message: "You do not have permission to download this snippet.",
            });
          case "NOT_FOUND":
            return new SnippetNotFoundError({
              message: "This snippet no longer exists.",
            });
          case "CONFLICT":
            return new SnippetConflictError({
              message: "The snippet changed elsewhere. Please try again.",
            });
          case "INTERNAL_SERVER_ERROR":
            return new ServerUnavailableError({
              message: "Plakk could not prepare the download. Please try again.",
            });
        }
      };

      /** Converts an RPC transport failure without exposing protocol details. */
      const rpcClientFailure = (error: RpcClientError): InvalidResponseError | OfflineError =>
        error.reason._tag === "RpcClientDefect"
          ? new InvalidResponseError({
              message: "Plakk received an unexpected response.",
            })
          : new OfflineError({
              message: "Plakk could not connect. Check your connection and try again.",
            });

      /** Converts a storage HTTP failure without exposing its URL or response. */
      const httpClientFailure = (
        error: HttpClientError.HttpClientError,
      ): InvalidResponseError | OfflineError =>
        error.reason._tag === "TransportError"
          ? new OfflineError({
              message: "The download could not connect. Check your connection and try again.",
            })
          : new InvalidResponseError({
              message: "The storage provider returned an unexpected response.",
            });

      /** Commits local availability and immediately publishes the new snippet snapshot. */
      const updateContentStatus = Effect.fn("ContentMirror.updateContentStatus")(
        function* (
          snippetId: string,
          status: "AVAILABLE" | "NOT_AVAILABLE" | "DOWNLOADING" | "FAILED",
          errorMessage: string | null,
        ) {
          yield* setContentStatus(session.user.id, snippetId, status, errorMessage);
          yield* snippets.refresh;
        },
        Effect.provideService(SqlClient.SqlClient, sql),
        Effect.catchTags({
          SqlError: () =>
            Effect.fail(
              new LocalStorageError({
                message: "Plakk could not update its local content state.",
              }),
            ),
        }),
      );

      /** Downloads and stores one already-resolved published snippet. */
      const downloadSnippet = Effect.fn("ContentMirror.downloadSnippet")(
        function* (snippet: PublishedSnippet) {
          if (content === undefined) {
            return yield* contentUnavailable();
          }
          const key = `${session.user.id}/${snippet.id}`;
          if (active.has(key)) return;
          active.add(key);

          const markFailed = updateContentStatus(snippet.id, "FAILED", "Download failed.");
          const retryLater = (error: ContentMirrorFailure) =>
            updateContentStatus(snippet.id, "NOT_AVAILABLE", null).pipe(
              Effect.andThen(
                Effect.sync(() => {
                  automaticAttempts.delete(key);
                }),
              ),
              Effect.andThen(Effect.fail(error)),
            );
          const fail = (error: ContentMirrorFailure) =>
            markFailed.pipe(
              Effect.catchCause(() => Effect.void),
              Effect.andThen(Effect.fail(error)),
            );
          const work = concurrency.withPermit(
            Effect.gen(function* () {
              yield* updateContentStatus(snippet.id, "DOWNLOADING", null);
              const prepared = yield* rpc.PrepareSnippetDownload({ id: snippet.id });
              if (
                prepared.storageProvider !== snippet.storageProvider ||
                prepared.fileName !== snippet.fileName ||
                prepared.byteSize !== snippet.byteSize
              ) {
                return yield* new PreparedDownloadMismatchError({
                  snippetId: snippet.id,
                  message: "The storage provider returned unexpected download metadata.",
                });
              }

              let request = HttpClientRequest.get(prepared.download.url);
              for (const header of prepared.download.headers) {
                request = HttpClientRequest.setHeader(request, header.name, header.value);
              }
              const response = yield* http.execute(request);
              if (response.status < 200 || response.status >= 300) {
                return yield* new DownloadRejectedError({
                  status: response.status,
                  message: "The storage provider rejected the download.",
                });
              }

              yield* content.write(snippet.id, snippet.byteSize, response.stream);
              yield* updateContentStatus(snippet.id, "AVAILABLE", null);
            }),
          );

          return yield* work.pipe(
            Effect.catchTags({
              SessionError: retryLater,
              OfflineError: retryLater,
              RpcClientError: (error) => {
                const failure = rpcClientFailure(error);
                return failure._tag === "OfflineError" ? retryLater(failure) : fail(failure);
              },
              HttpClientError: (error) => {
                const failure = httpClientFailure(error);
                return failure._tag === "OfflineError" ? retryLater(failure) : fail(failure);
              },
              RpcError: (error) => {
                const failure = rpcFailure(error);
                return failure._tag === "SessionError" || failure._tag === "ServerUnavailableError"
                  ? retryLater(failure)
                  : fail(failure);
              },
              LocalStorageError: fail,
              DownloadRejectedError: (error) =>
                error.status === 408 || error.status === 429 || error.status >= 500
                  ? retryLater(error)
                  : fail(error),
              PreparedDownloadMismatchError: fail,
            }),
            Effect.onInterrupt(() =>
              retryLater(
                new OfflineError({
                  message: "The local download was interrupted.",
                }),
              ).pipe(Effect.catchCause(() => Effect.void)),
            ),
            Effect.ensuring(
              Effect.sync(() => {
                active.delete(key);
              }),
            ),
          );
        },
        Effect.provideService(SqlClient.SqlClient, sql),
      );

      /** Downloads and atomically stores one published snippet. */
      const download = Effect.fn("ContentMirror.download")(
        function* (snippetId: string) {
          const snippets = yield* listPublishedSnippets(session.user.id);
          const snippet = snippets.find((candidate) => candidate.id === snippetId);
          if (snippet === undefined) {
            return yield* new SnippetNotPublishedError({
              snippetId,
              message: "This snippet is not available for download.",
            });
          }
          yield* downloadSnippet(snippet);
        },
        Effect.provideService(SqlClient.SqlClient, sql),
        Effect.catchTags({
          SchemaError: () =>
            Effect.fail(
              new LocalStorageError({
                message: "Plakk could not read its local snippet data.",
              }),
            ),
          SqlError: () =>
            Effect.fail(
              new LocalStorageError({
                message: "Plakk could not read its local snippet data.",
              }),
            ),
        }),
      );

      /** Streams published content without retaining a device-local copy. */
      const readRemote = (snippetId: string): Stream.Stream<Uint8Array, ContentMirrorFailure> =>
        Stream.unwrap(
          Effect.gen(function* () {
            const published = yield* listPublishedSnippets(session.user.id);
            const snippet = published.find((candidate) => candidate.id === snippetId);
            if (snippet === undefined) {
              return yield* new SnippetNotPublishedError({
                snippetId,
                message: "This snippet is not available.",
              });
            }

            const prepared = yield* rpc.PrepareSnippetDownload({ id: snippet.id });
            if (
              prepared.storageProvider !== snippet.storageProvider ||
              prepared.fileName !== snippet.fileName ||
              prepared.byteSize !== snippet.byteSize
            ) {
              return yield* new PreparedDownloadMismatchError({
                snippetId: snippet.id,
                message: "The storage provider returned unexpected download metadata.",
              });
            }

            let request = HttpClientRequest.get(prepared.download.url);
            for (const header of prepared.download.headers) {
              request = HttpClientRequest.setHeader(request, header.name, header.value);
            }
            const response = yield* http.execute(request);
            if (response.status < 200 || response.status >= 300) {
              return yield* new DownloadRejectedError({
                status: response.status,
                message: "The storage provider rejected the download.",
              });
            }
            let receivedByteSize = 0;
            const mismatch = () =>
              new DownloadedContentMismatchError({
                snippetId: snippet.id,
                expectedByteSize: snippet.byteSize,
                actualByteSize: receivedByteSize,
                message: "The downloaded content size does not match the snippet.",
              });
            return response.stream.pipe(
              Stream.mapEffect((chunk) => {
                receivedByteSize += chunk.byteLength;
                return receivedByteSize > snippet.byteSize
                  ? Effect.fail(mismatch())
                  : Effect.succeed(chunk);
              }),
              Stream.mapError((error) =>
                Schema.is(DownloadedContentMismatchError)(error) ? error : httpClientFailure(error),
              ),
              Stream.concat(
                Stream.fromEffect(
                  Effect.suspend(() =>
                    receivedByteSize === snippet.byteSize ? Effect.void : Effect.fail(mismatch()),
                  ),
                ).pipe(Stream.drain),
              ),
            );
          }).pipe(
            Effect.provideService(SqlClient.SqlClient, sql),
            Effect.catchTags({
              HttpClientError: (error) => Effect.fail(httpClientFailure(error)),
              RpcClientError: (error) => Effect.fail(rpcClientFailure(error)),
              RpcError: (error) => Effect.fail(rpcFailure(error)),
              SchemaError: () =>
                Effect.fail(
                  new LocalStorageError({
                    message: "Plakk could not read its local snippet data.",
                  }),
                ),
              SqlError: () =>
                Effect.fail(
                  new LocalStorageError({
                    message: "Plakk could not read its local snippet data.",
                  }),
                ),
            }),
          ),
        );

      /** Repairs local availability and downloads the automatic newest-twenty set. */
      const reconcile = Effect.gen(function* () {
        if (content === undefined) return;

        const localSnippets = yield* listSnippets(session.user.id);
        const publishedSnippets = localSnippets.filter(isPublishedSnippet);
        const stored = yield* content.entries;
        const snippetsById = new Map(localSnippets.map((snippet) => [snippet.id, snippet]));
        const invalid = stored
          .filter((entry) => {
            const snippet = snippetsById.get(entry.snippetId);
            return snippet === undefined || snippet.byteSize !== entry.byteSize;
          })
          .map((entry) => entry.snippetId);
        if (invalid.length > 0) {
          yield* content.remove(invalid);
        }

        const available = new Set(
          stored
            .filter((entry) => snippetsById.get(entry.snippetId)?.byteSize === entry.byteSize)
            .map((entry) => entry.snippetId),
        );
        yield* Effect.forEach(
          publishedSnippets,
          (snippet) => {
            const key = `${session.user.id}/${snippet.id}`;
            if (
              active.has(key) ||
              (!available.has(snippet.id) && snippet.localContentAvailability.status === "FAILED")
            ) {
              return Effect.void;
            }
            return setContentStatus(
              session.user.id,
              snippet.id,
              available.has(snippet.id) ? "AVAILABLE" : "NOT_AVAILABLE",
              null,
            );
          },
          { discard: true },
        );
        yield* snippets.refresh;

        const automatic = automaticSnippets(publishedSnippets);
        const automaticKeys = new Set(
          automatic.map((snippet) => `${session.user.id}/${snippet.id}`),
        );
        for (const key of automaticAttempts) {
          if (key.startsWith(`${session.user.id}/`) && !automaticKeys.has(key)) {
            automaticAttempts.delete(key);
          }
        }
        yield* Effect.forEach(
          automatic,
          (snippet) => {
            const key = `${session.user.id}/${snippet.id}`;
            if (available.has(snippet.id) || automaticAttempts.has(key)) {
              return Effect.void;
            }
            automaticAttempts.add(key);
            return downloadSnippet(snippet).pipe(
              Effect.catch((error) =>
                Effect.logWarning("Automatic snippet download failed", {
                  snippetId: snippet.id,
                  error,
                }),
              ),
            );
          },
          { concurrency: 2, discard: true },
        );
      }).pipe(
        Effect.provideService(SqlClient.SqlClient, sql),
        Effect.catchTags({
          SchemaError: () =>
            Effect.fail(
              new LocalStorageError({
                message: "Plakk could not read its local snippet data.",
              }),
            ),
          SqlError: () =>
            Effect.fail(
              new LocalStorageError({
                message: "Plakk could not update its local content state.",
              }),
            ),
        }),
        Effect.withSpan("ContentMirror.reconcile"),
      );

      /** Removes managed content outside the automatic newest-twenty set. */
      const freeUp = Effect.gen(function* () {
        if (content === undefined) {
          return {
            reclaimedBytes: 0,
            removedCopies: 0,
            storageUsageBytes: 0,
          };
        }

        const publishedSnippets = yield* listPublishedSnippets(session.user.id);
        const retained = new Set(automaticSnippets(publishedSnippets).map((snippet) => snippet.id));
        const stored = yield* content.entries;
        const removed = stored.filter((entry) => !retained.has(entry.snippetId));
        if (removed.length > 0) {
          yield* content.remove(removed.map((entry) => entry.snippetId));
          yield* Effect.forEach(
            removed,
            (entry) => setContentStatus(session.user.id, entry.snippetId, "NOT_AVAILABLE", null),
            { discard: true },
          );
          yield* snippets.refresh;
        }

        return {
          reclaimedBytes: removed.reduce((total, entry) => total + entry.byteSize, 0),
          removedCopies: removed.length,
          storageUsageBytes: stored
            .filter((entry) => retained.has(entry.snippetId))
            .reduce((total, entry) => total + entry.byteSize, 0),
        };
      }).pipe(
        Effect.provideService(SqlClient.SqlClient, sql),
        Effect.catchTags({
          SchemaError: () =>
            Effect.fail(
              new LocalStorageError({
                message: "Plakk could not read its local snippet data.",
              }),
            ),
          SqlError: () =>
            Effect.fail(
              new LocalStorageError({
                message: "Plakk could not update its local content state.",
              }),
            ),
        }),
        Effect.withSpan("ContentMirror.freeUp"),
      );

      return ContentMirror.of({
        reconcile,
        download,
        freeUp,
        readRemote,
        read:
          content === undefined
            ? () => Stream.fail(contentUnavailable())
            : (snippetId) =>
                content.read(snippetId).pipe(
                  Stream.mapError(
                    () =>
                      new LocalStorageError({
                        message: "Plakk could not read the locally stored content.",
                      }),
                  ),
                ),
      });
    }),
  );
}
