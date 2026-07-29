import type {
  OfflineError,
  PrepareSnippetUploadPayload,
  SessionError,
} from "@plakk/shared/PlakkApi";
import type { RpcError } from "@plakk/shared/RpcError";
import {
  decodeSnippetTextPreview,
  deriveSnippetPresentation,
  isTextSnippetFileName,
  SNIPPET_TEXT_PREVIEW_MAX_BYTES,
} from "@plakk/shared";
import {
  Context,
  DateTime,
  Duration,
  Effect,
  FiberSet,
  Layer,
  Option,
  Schema,
  Semaphore,
  Stream,
} from "effect";
import { Headers, HttpClient, type HttpClientError, HttpClientRequest } from "effect/unstable/http";
import type { RpcClientError } from "effect/unstable/rpc/RpcClientError";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import type * as SqlError from "effect/unstable/sql/SqlError";

import { CurrentSession } from "../CurrentSession.ts";
import { LocalStorageError } from "../models/ClientError.ts";
import { RpcClient } from "../RpcClient.ts";
import { setContentStatus } from "../sqlite/queries/content.ts";
import { removeSnippet } from "../sqlite/queries/snippets.ts";
import {
  createPreparingSnippet,
  discardFailedSnippet,
  failInterruptedUploads,
  markSnippetPublished,
  markSnippetPreparing,
  markSnippetUploadFailed,
  markSnippetUploading,
  SnippetAlreadyExistsError,
} from "../sqlite/queries/uploads.ts";
import { ContentStore } from "./ContentMirror.ts";
import { SnippetStore } from "./SnippetStore.ts";

const CONTENT_COPY_CHUNK_BYTES = 4 * 1024 * 1024;
const MAX_UPLOAD_RETRIES = 5;

const NextExpectedRangesSchema = Schema.Struct({
  nextExpectedRanges: Schema.Array(Schema.String),
});
const UploadedObjectSchema = Schema.Struct({ id: Schema.String });

export interface UploadSource<E = never> {
  /** Reads exactly the requested byte range from the local snippet content. */
  readonly read: (offset: number, byteSize: number) => Effect.Effect<Uint8Array, E>;
}

export class UploadSourceChangedError extends Schema.TaggedErrorClass<UploadSourceChangedError>()(
  "UploadSourceChangedError",
  {
    expectedByteSize: Schema.Int,
    actualByteSize: Schema.Int,
    message: Schema.String,
  },
) {}

export class UploadSourceUnavailableError extends Schema.TaggedErrorClass<UploadSourceUnavailableError>()(
  "UploadSourceUnavailableError",
  { message: Schema.String },
) {}

export class UploadRejectedError extends Schema.TaggedErrorClass<UploadRejectedError>()(
  "UploadRejectedError",
  {
    status: Schema.Int,
    message: Schema.String,
  },
) {}

export class InvalidUploadResponseError extends Schema.TaggedErrorClass<InvalidUploadResponseError>()(
  "InvalidUploadResponseError",
  { message: Schema.String },
) {}

export type UploadFailure =
  | LocalStorageError
  | SnippetAlreadyExistsError
  | UploadSourceChangedError
  | UploadSourceUnavailableError;

type UploadAttemptFailure =
  | HttpClientError.HttpClientError
  | InvalidUploadResponseError
  | LocalStorageError
  | OfflineError
  | RpcClientError
  | RpcError
  | Schema.SchemaError
  | SessionError
  | SqlError.SqlError
  | UploadRejectedError
  | UploadSourceChangedError
  | UploadSourceUnavailableError;

type TitledUploadInput = PrepareSnippetUploadPayload & { readonly title?: string };

export class UploadEngine extends Context.Service<
  UploadEngine,
  {
    /** Stores a snippet locally and starts its background upload. */
    readonly upload: (
      input: PrepareSnippetUploadPayload,
      source: UploadSource<UploadSourceUnavailableError>,
    ) => Effect.Effect<void, UploadFailure>;
    /** Marks uploads left by a previous process as failed and refreshes local state. */
    readonly initialize: Effect.Effect<void, LocalStorageError>;
    /** Dismisses and removes one failed local snippet. */
    readonly discard: (snippetId: string) => Effect.Effect<void, LocalStorageError>;
  }
>()("@plakk/client-runtime/snippets/UploadEngine") {
  static readonly Live = Layer.effect(
    UploadEngine,
    Effect.gen(function* () {
      const session = yield* CurrentSession;
      const rpc = yield* RpcClient;
      const http = yield* HttpClient.HttpClient;
      const sql = yield* SqlClient.SqlClient;
      const snippets = yield* SnippetStore;
      const content = Option.getOrUndefined(yield* Effect.serviceOption(ContentStore));
      const concurrency = yield* Semaphore.make(2);
      const activeUploads = yield* FiberSet.make<void, never>();
      const activeSnippetIds = new Set<string>();

      /** Dismisses and removes one failed local snippet. */
      const discard = Effect.fn("UploadEngine.discard")(
        function* (snippetId: string) {
          const removed = yield* discardFailedSnippet(session.user.id, snippetId);
          if (removed && content !== undefined) {
            yield* content.remove([snippetId]);
          }
          yield* snippets.refresh;
        },
        Effect.provideService(SqlClient.SqlClient, sql),
        Effect.catchTags({
          SchemaError: () =>
            Effect.fail(
              new LocalStorageError({
                message: "Plakk could not remove the local snippet.",
              }),
            ),
          SqlError: () =>
            Effect.fail(
              new LocalStorageError({
                message: "Plakk could not remove the local snippet.",
              }),
            ),
        }),
      );

      /** Streams the platform source once while validating every requested range. */
      const streamSource = <E>(
        input: PrepareSnippetUploadPayload,
        source: UploadSource<E>,
      ): Stream.Stream<Uint8Array, E | UploadSourceChangedError> =>
        Stream.unfold(0, (offset: number) => {
          if (offset >= input.byteSize) return Effect.succeed(undefined);
          const byteSize = Math.min(CONTENT_COPY_CHUNK_BYTES, input.byteSize - offset);
          return source.read(offset, byteSize).pipe(
            Effect.flatMap((bytes) =>
              bytes.byteLength === byteSize
                ? Effect.succeed([bytes, offset + byteSize] as const)
                : Effect.fail(
                    new UploadSourceChangedError({
                      expectedByteSize: byteSize,
                      actualByteSize: bytes.byteLength,
                      message: "The selected file changed while it was being uploaded.",
                    }),
                  ),
            ),
          );
        });

      /** Derives the immutable title once from the beginning of text content. */
      const deriveTitle = Effect.fn("UploadEngine.deriveTitle")(function* <E>(
        input: PrepareSnippetUploadPayload,
        source: UploadSource<E>,
      ) {
        if (!isTextSnippetFileName(input.fileName)) return undefined;

        const byteSize = Math.min(input.byteSize, SNIPPET_TEXT_PREVIEW_MAX_BYTES);
        const bytes = yield* source.read(0, byteSize);
        if (bytes.byteLength !== byteSize) {
          return yield* new UploadSourceChangedError({
            expectedByteSize: byteSize,
            actualByteSize: bytes.byteLength,
            message: "The selected file changed while it was being uploaded.",
          });
        }
        const content = decodeSnippetTextPreview(bytes, input.byteSize > byteSize);
        return content === null
          ? undefined
          : deriveSnippetPresentation({ fileName: input.fileName, content }).title;
      });

      /** Changes one preparing snippet to its active transfer state. */
      const setUploading = Effect.fn("UploadEngine.setUploading")(
        function* (snippetId: string) {
          const updatedAt = DateTime.formatIso(yield* DateTime.now);
          yield* markSnippetUploading(session.user.id, snippetId, updatedAt);
          yield* snippets.refresh;
        },
        Effect.provideService(SqlClient.SqlClient, sql),
      );

      /** Returns one active upload to its durable preparing state. */
      const setPreparing = Effect.fn("UploadEngine.setPreparing")(
        function* (snippetId: string) {
          const updatedAt = DateTime.formatIso(yield* DateTime.now);
          yield* markSnippetPreparing(session.user.id, snippetId, updatedAt);
          yield* snippets.refresh;
        },
        Effect.provideService(SqlClient.SqlClient, sql),
      );

      /** Records one permanent upload failure for presentation and dismissal. */
      const setFailed = Effect.fn("UploadEngine.setFailed")(
        function* (snippetId: string, message: string) {
          const updatedAt = DateTime.formatIso(yield* DateTime.now);
          yield* markSnippetUploadFailed(session.user.id, snippetId, updatedAt, message);
          yield* snippets.refresh;
        },
        Effect.provideService(SqlClient.SqlClient, sql),
      );

      /** Transfers and publishes one already-persisted preparing snippet. */
      const transfer = Effect.fn("UploadEngine.transfer")(
        function* (
          input: TitledUploadInput,
          source: UploadSource<LocalStorageError | UploadSourceUnavailableError>,
        ) {
          const prepared = yield* rpc.PrepareSnippetUpload({
            id: input.id,
            fileName: input.fileName,
            byteSize: input.byteSize,
            storageProvider: input.storageProvider,
            mediaType: input.mediaType,
          });
          if (prepared.storageProvider !== input.storageProvider) {
            return yield* new InvalidUploadResponseError({
              message: "The prepared upload uses a different storage provider.",
            });
          }

          /** Reads and sends one exact range of the persisted snippet content. */
          const sendPart = Effect.fn("UploadEngine.sendPart")(function* (
            offset: number,
            byteSize: number,
          ) {
            const bytes = yield* source.read(offset, byteSize);
            if (bytes.byteLength !== byteSize) {
              return yield* new UploadSourceChangedError({
                expectedByteSize: byteSize,
                actualByteSize: bytes.byteLength,
                message: "The selected file changed while it was being uploaded.",
              });
            }

            let request =
              prepared.upload.method === "POST"
                ? HttpClientRequest.post(prepared.upload.url)
                : HttpClientRequest.put(prepared.upload.url);
            for (const header of prepared.upload.headers) {
              request = HttpClientRequest.setHeader(request, header.name, header.value);
            }
            if (prepared.upload.strategy.type === "byte_range") {
              request = HttpClientRequest.setHeader(
                request,
                "Content-Range",
                `bytes ${offset}-${offset + byteSize - 1}/${input.byteSize}`,
              );
            }
            return yield* http.execute(HttpClientRequest.bodyUint8Array(request, bytes));
          });

          let storageObjectId = prepared.storageObjectId;

          if (prepared.upload.strategy.type === "single_request") {
            const response = yield* sendPart(0, input.byteSize);
            if (response.status < 200 || response.status >= 300) {
              return yield* new UploadRejectedError({
                status: response.status,
                message: "The storage provider rejected the upload.",
              });
            }
            if (storageObjectId === null) {
              const uploaded = yield* response.json.pipe(
                Effect.flatMap(Schema.decodeUnknownEffect(UploadedObjectSchema)),
              );
              storageObjectId = uploaded.id;
            }
          } else {
            const partByteSize =
              Math.floor(
                prepared.upload.strategy.maxPartByteSize /
                  prepared.upload.strategy.partByteMultiple,
              ) * prepared.upload.strategy.partByteMultiple;
            if (partByteSize < 1) {
              return yield* new InvalidUploadResponseError({
                message: "The prepared upload has an invalid part size.",
              });
            }

            let offset = 0;
            while (offset < input.byteSize) {
              const byteSize = Math.min(partByteSize, input.byteSize - offset);
              const response = yield* sendPart(offset, byteSize);

              if (response.status === 308) {
                const range = Option.getOrNull(Headers.get(response.headers, "range"));
                const end = range === null ? null : /(?:bytes=|bytes )\d+-(\d+)/.exec(range)?.[1];
                const next = end === null || end === undefined ? null : Number(end) + 1;
                if (
                  next === null ||
                  next <= offset ||
                  next > offset + byteSize ||
                  next > input.byteSize
                ) {
                  return yield* new InvalidUploadResponseError({
                    message: "The upload provider returned an invalid byte range.",
                  });
                }
                offset = next;
                continue;
              }

              if (response.status === 202) {
                const body = yield* response.json.pipe(
                  Effect.flatMap(Schema.decodeUnknownEffect(NextExpectedRangesSchema)),
                );
                const nextRange = body.nextExpectedRanges[0];
                const next = nextRange === undefined ? null : Number(/^\d+/.exec(nextRange)?.[0]);
                if (
                  next === null ||
                  !Number.isSafeInteger(next) ||
                  next <= offset ||
                  next > offset + byteSize ||
                  next > input.byteSize
                ) {
                  return yield* new InvalidUploadResponseError({
                    message: "The upload provider returned an invalid next range.",
                  });
                }
                offset = next;
                continue;
              }

              if (response.status < 200 || response.status >= 300) {
                return yield* new UploadRejectedError({
                  status: response.status,
                  message: "The storage provider rejected the upload.",
                });
              }
              if (offset + byteSize !== input.byteSize) {
                return yield* new InvalidUploadResponseError({
                  message: "The upload completed before the entire source was sent.",
                });
              }
              if (storageObjectId === null) {
                const uploaded = yield* response.json.pipe(
                  Effect.flatMap(Schema.decodeUnknownEffect(UploadedObjectSchema)),
                );
                storageObjectId = uploaded.id;
              }
              offset += byteSize;
            }
          }

          if (storageObjectId === null || storageObjectId === "") {
            return yield* new InvalidUploadResponseError({
              message: "The upload provider did not return an object ID.",
            });
          }

          const published = yield* rpc.PublishSnippet({
            id: input.id,
            fileName: input.fileName,
            ...(input.title === undefined ? {} : { title: input.title }),
            byteSize: input.byteSize,
            storageProvider: input.storageProvider,
            storageObjectId,
          });

          yield* markSnippetPublished(session.user.id, published);
          yield* snippets.refresh;
        },
        Effect.provideService(SqlClient.SqlClient, sql),
      );

      /** Starts one deduplicated background upload with typed retry behavior. */
      const launch = Effect.fn("UploadEngine.launch")(function* (
        input: TitledUploadInput,
        source: UploadSource<LocalStorageError | UploadSourceUnavailableError>,
      ) {
        if (activeSnippetIds.has(input.id)) return;
        activeSnippetIds.add(input.id);
        let retryCount = 0;

        /** Waits before re-running a temporarily blocked upload. */
        const retry = (
          reason: "offline" | "server" | "session",
          error: UploadAttemptFailure,
        ): Effect.Effect<void> => {
          if (retryCount >= MAX_UPLOAD_RETRIES) return fail(error);
          const delay = Duration.seconds(2 ** retryCount);
          retryCount += 1;
          return setPreparing(input.id).pipe(
            Effect.catchCause((cause) =>
              Effect.logWarning("Could not return an upload to preparing", {
                snippetId: input.id,
                cause,
              }),
            ),
            Effect.andThen(
              Effect.logInfo("Snippet upload is preparing to retry", {
                snippetId: input.id,
                reason,
              }),
            ),
            Effect.andThen(Effect.sleep(delay)),
            Effect.andThen(runAttempt()),
          );
        };

        /** Marks failures that cannot be recovered without a new user action. */
        const fail = (error: UploadAttemptFailure): Effect.Effect<void> =>
          setFailed(input.id, "Upload failed.").pipe(
            Effect.catchCause((cause) =>
              Effect.logWarning("Could not mark a failed upload", {
                snippetId: input.id,
                cause,
              }),
            ),
            Effect.andThen(
              Effect.logWarning("Snippet upload failed", {
                snippetId: input.id,
                error,
              }),
            ),
          );

        /** Runs one attempt and exhaustively chooses retry or permanent failure. */
        function runAttempt(): Effect.Effect<void> {
          return concurrency
            .withPermit(setUploading(input.id).pipe(Effect.andThen(transfer(input, source))))
            .pipe(
              Effect.catchTags({
                SessionError: (error) => retry("session", error),
                OfflineError: (error) => retry("offline", error),
                RpcClientError: (error) =>
                  error.reason._tag === "RpcClientDefect"
                    ? Effect.fail(
                        new InvalidUploadResponseError({
                          message: "Plakk received an unexpected upload response.",
                        }),
                      )
                    : retry("offline", error),
                HttpClientError: (error) =>
                  error.reason._tag === "TransportError"
                    ? retry("offline", error)
                    : Effect.fail(
                        new InvalidUploadResponseError({
                          message: "The storage provider returned an unexpected response.",
                        }),
                      ),
                RpcError: (error) =>
                  error.code === "UNAUTHENTICATED"
                    ? retry("session", error)
                    : error.code === "INTERNAL_SERVER_ERROR"
                      ? retry("server", error)
                      : Effect.fail(error),
                UploadRejectedError: (error) =>
                  error.status === 408 || error.status === 429 || error.status >= 500
                    ? retry("server", error)
                    : Effect.fail(error),
              }),
              Effect.catch(fail),
            );
        }

        const background = runAttempt().pipe(
          Effect.onInterrupt(() =>
            setFailed(input.id, "This upload was interrupted.").pipe(
              Effect.catchCause(() => Effect.void),
            ),
          ),
          Effect.ensuring(
            Effect.sync(() => {
              activeSnippetIds.delete(input.id);
            }),
          ),
        );
        if (content === undefined) {
          yield* background;
        } else {
          yield* FiberSet.run(activeUploads, background, { propagateInterruption: false });
        }
      });

      /** Marks uploads left by a previous process as failed and refreshes local state. */
      const initialize = Effect.gen(function* () {
        const updatedAt = DateTime.formatIso(yield* DateTime.now);
        yield* failInterruptedUploads(session.user.id, updatedAt);
        yield* snippets.refresh;
      }).pipe(
        Effect.provideService(SqlClient.SqlClient, sql),
        Effect.catchTags({
          SqlError: () =>
            Effect.fail(
              new LocalStorageError({
                message: "Plakk could not initialize its local uploads.",
              }),
            ),
        }),
        Effect.withSpan("UploadEngine.initialize"),
      );

      /** Stores a snippet locally and starts its transfer in the managed upload scope. */
      const upload: UploadEngine["Service"]["upload"] = Effect.fn("UploadEngine.upload")(
        function* (
          input: PrepareSnippetUploadPayload,
          source: UploadSource<UploadSourceUnavailableError>,
        ) {
          const title = yield* deriveTitle(input, source);
          const titledInput: TitledUploadInput = title === undefined ? input : { ...input, title };
          const createdAt = DateTime.formatIso(yield* DateTime.now);
          yield* createPreparingSnippet(session.user.id, titledInput, createdAt);
          yield* snippets.refresh;

          let uploadSource: UploadSource<LocalStorageError | UploadSourceUnavailableError> = {
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
          if (content !== undefined) {
            const cleanupFailedCopy = Effect.all(
              [
                content.remove([input.id]).pipe(Effect.catchCause(() => Effect.void)),
                removeSnippet(session.user.id, input.id).pipe(
                  Effect.provideService(SqlClient.SqlClient, sql),
                  Effect.catchCause(() => Effect.void),
                ),
              ],
              { discard: true },
            ).pipe(
              Effect.andThen(snippets.refresh),
              Effect.catchCause(() => Effect.void),
            );
            yield* Effect.gen(function* () {
              yield* content.write(input.id, input.byteSize, streamSource(input, source));
              yield* setContentStatus(session.user.id, input.id, "AVAILABLE", null);
            }).pipe(Effect.onError(() => cleanupFailedCopy));
            yield* snippets.refresh;
            uploadSource = {
              read: (offset, byteSize) => content.readRange(input.id, offset, byteSize),
            };
          }

          yield* launch(titledInput, uploadSource);
        },
        Effect.provideService(SqlClient.SqlClient, sql),
        Effect.catchTags({
          SchemaError: () =>
            Effect.fail(
              new LocalStorageError({
                message: "Plakk could not create the local snippet.",
              }),
            ),
          SqlError: () =>
            Effect.fail(
              new LocalStorageError({
                message: "Plakk could not create the local snippet.",
              }),
            ),
        }),
      );

      return UploadEngine.of({ upload, initialize, discard });
    }),
  );
}

export { SnippetAlreadyExistsError };
