import { deriveSnippetPresentation } from "@plakk/shared";
import type { ApiSnippet } from "@plakk/shared/PlakkApi";
import {
  Context,
  DateTime,
  Deferred,
  Effect,
  Fiber,
  Layer,
  PubSub,
  Ref,
  Schedule,
  Schema,
  Semaphore,
  Stream,
} from "effect";

import type { DesktopSnippet, SnippetIngestPayload } from "../ipc/contracts.ts";
import { StorageUpload } from "../storageUpload.ts";
import { DesktopManagedSnippetContent } from "./ManagedSnippetContent.ts";
import { SnippetUploadOutbox, type SnippetUploadOutboxEntry } from "./SnippetUploadOutbox.ts";
import { SnippetUploadRemote } from "./SnippetUploadRemote.ts";

type UploadAccount = { readonly id: string; readonly accessToken: string };
type UploadOwner = { readonly id: string; readonly accessToken: string | null };
type ImportProjection = {
  readonly accountId: string;
  readonly input: SnippetIngestPayload;
  readonly createdAt: string;
  readonly localTextContent: string | null;
};

export class SnippetUploadEngineError extends Schema.TaggedErrorClass<SnippetUploadEngineError>()(
  "SnippetUploadEngineError",
  {
    cause: Schema.Defect(),
    reason: Schema.String,
    canRetry: Schema.Boolean,
  },
) {}

const errorReason = (cause: unknown, fallback: string) => {
  if (
    typeof cause === "object" &&
    cause !== null &&
    "reason" in cause &&
    typeof cause.reason === "string"
  ) {
    return cause.reason;
  }
  if (
    typeof cause === "object" &&
    cause !== null &&
    "message" in cause &&
    typeof cause.message === "string"
  ) {
    return cause.message;
  }
  return fallback;
};

const engineError = (cause: unknown, fallback: string, canRetry: boolean) =>
  cause instanceof SnippetUploadEngineError
    ? cause
    : new SnippetUploadEngineError({
        cause,
        reason: errorReason(cause, fallback),
        canRetry,
      });

const nestedFailure = (cause: unknown, predicate: (value: object) => boolean): boolean => {
  let current = cause;
  for (let depth = 0; depth < 5 && typeof current === "object" && current !== null; depth += 1) {
    if (predicate(current)) return true;
    current = "cause" in current ? current.cause : null;
  }
  return false;
};

const isTransientUploadFailure = (cause: unknown) =>
  nestedFailure(
    cause,
    (value) =>
      ("code" in value && value.code === "INTERNAL_SERVER_ERROR") ||
      ("_tag" in value && value._tag === "RpcClientError") ||
      ("_tag" in value &&
        value._tag === "StorageUploadError" &&
        "retryable" in value &&
        value.retryable === true),
  );

const localTextFrom = (input: SnippetIngestPayload): string | null => {
  if (!("bytes" in input)) return null;
  const presentation = deriveSnippetPresentation({ fileName: input.fileName });
  return presentation.type === "text" || presentation.type === "hyperlink"
    ? new TextDecoder().decode(input.bytes)
    : null;
};

const importProjection = (value: ImportProjection): DesktopSnippet => ({
  id: value.input.id,
  fileName: value.input.fileName,
  byteSize: value.input.byteSize,
  storageProvider: value.input.storageProvider,
  storageObjectId: null,
  uploadStatus: null,
  createdAt: value.createdAt,
  updatedAt: value.createdAt,
  localState: {
    phase: "IMPORTING",
    progress: 0,
    errorMessage: null,
    canRetry: false,
  },
  localTextContent: value.localTextContent,
  contentAvailable: value.localTextContent !== null,
});

const localState = (entry: SnippetUploadOutboxEntry): DesktopSnippet["localState"] => {
  if (entry.phase === "UPLOADED") return null;
  if (entry.phase === "FAILED") {
    return {
      phase: "FAILED",
      progress: entry.progress,
      errorMessage: entry.errorMessage ?? "This snippet could not be uploaded.",
      canRetry: entry.canRetry,
    };
  }
  return {
    phase: entry.phase,
    progress: entry.progress,
    errorMessage: null,
    canRetry: false,
  };
};

export class SnippetUploadEngine extends Context.Service<
  SnippetUploadEngine,
  {
    readonly changes: Stream.Stream<string>;
    ingest(
      accountId: string,
      input: SnippetIngestPayload,
    ): Effect.Effect<void, SnippetUploadEngineError>;
    resume(account: UploadAccount): Effect.Effect<void, SnippetUploadEngineError>;
    pause: Effect.Effect<void>;
    project(
      accountId: string,
      replicaItems: ReadonlyArray<ApiSnippet>,
    ): Effect.Effect<ReadonlyArray<DesktopSnippet>, SnippetUploadEngineError>;
    cancel(account: UploadOwner, snippetId: string): Effect.Effect<void, SnippetUploadEngineError>;
    retry(account: UploadOwner, snippetId: string): Effect.Effect<void, SnippetUploadEngineError>;
    discard(accountId: string, snippetId: string): Effect.Effect<void, SnippetUploadEngineError>;
    delete(account: UploadOwner, snippetId: string): Effect.Effect<void, SnippetUploadEngineError>;
    reconcile(
      accountId: string,
      replicaItems: ReadonlyArray<ApiSnippet>,
    ): Effect.Effect<void, SnippetUploadEngineError>;
  }
>()("plakk/main/SnippetUploadEngine") {
  static readonly Live = Layer.effect(
    SnippetUploadEngine,
    Effect.gen(function* () {
      const content = yield* DesktopManagedSnippetContent;
      const outbox = yield* SnippetUploadOutbox;
      const remote = yield* SnippetUploadRemote;
      const storage = yield* StorageUpload;
      const changes = yield* PubSub.unbounded<string>();
      const currentAccount = yield* Ref.make<UploadAccount | null>(null);
      const concurrency = yield* Semaphore.make(2);
      const imports = new Map<string, ImportProjection>();
      const importCancellations = new Map<string, Deferred.Deferred<void>>();
      const progressById = new Map<string, number>();
      const active = new Map<string, Fiber.Fiber<void, unknown> | null>();

      const publish = (accountId: string) => PubSub.publish(changes, accountId);
      const publishFromCallback = (accountId: string) => Effect.runFork(publish(accountId));

      const put = Effect.fn("SnippetUploadEngine.put")(function* (
        accountId: string,
        entry: SnippetUploadOutboxEntry,
      ) {
        yield* outbox
          .put(accountId, entry)
          .pipe(Effect.mapError((cause) => engineError(cause, cause.reason, false)));
        yield* publish(accountId);
      });

      const markFailed = Effect.fn("SnippetUploadEngine.markFailed")(function* (
        account: UploadOwner,
        snippetId: string,
        failure: SnippetUploadEngineError,
      ) {
        const entry = yield* outbox
          .get(account.id, snippetId)
          .pipe(Effect.mapError((cause) => engineError(cause, cause.reason, false)));
        if (entry === null || entry.phase === "UPLOADED") return;

        let authoritativeStatus = entry.authoritativeStatus;
        if (authoritativeStatus === "UPLOADING" && account.accessToken !== null) {
          const failed = yield* remote.fail(account.accessToken, snippetId).pipe(Effect.result);
          if (failed._tag === "Success") authoritativeStatus = failed.success.uploadStatus;
        }
        const now = DateTime.formatIso(yield* DateTime.now);
        const progress = progressById.get(snippetId) ?? entry.progress;
        progressById.delete(snippetId);
        yield* put(account.id, {
          ...entry,
          phase: "FAILED",
          progress,
          authoritativeStatus,
          errorMessage: failure.reason,
          canRetry: failure.canRetry,
          updatedAt: now,
        });
      });

      const runEntry = Effect.fn("SnippetUploadEngine.runEntry")(function* (
        account: UploadAccount,
        snippetId: string,
      ) {
        let entry = yield* outbox
          .get(account.id, snippetId)
          .pipe(Effect.mapError((cause) => engineError(cause, cause.reason, false)));
        if (entry === null || entry.phase !== "QUEUED") return;

        const startedAt = DateTime.formatIso(yield* DateTime.now);
        entry = {
          ...entry,
          phase: "UPLOADING",
          progress: 0,
          errorMessage: null,
          canRetry: false,
          updatedAt: startedAt,
        };
        yield* put(account.id, entry);

        const filePath = yield* content
          .path(account.id, entry.id, entry.byteSize)
          .pipe(Effect.mapError((cause) => engineError(cause, cause.reason, false)));

        if (entry.authoritativeStatus === null) {
          const created = yield* remote
            .create(account.accessToken, {
              id: entry.id,
              fileName: entry.fileName,
              byteSize: entry.byteSize,
              storageProvider: entry.storageProvider,
            })
            .pipe(
              Effect.mapError((cause) =>
                engineError(cause, "Plakk could not start this upload.", true),
              ),
            );
          entry = {
            ...entry,
            authoritativeStatus: created.uploadStatus,
            storageObjectId: created.storageObjectId,
            updatedAt: created.updatedAt,
          };
          yield* put(account.id, entry);
        }

        const uploadEntry = entry;
        const transfer = Effect.gen(function* () {
          yield* remote
            .heartbeat(account.accessToken, uploadEntry.id)
            .pipe(
              Effect.mapError((cause) =>
                engineError(cause, "Plakk could not keep this upload active.", true),
              ),
            );
          const prepared = yield* remote
            .prepare(account.accessToken, {
              snippetId: uploadEntry.id,
              mediaType: uploadEntry.mediaType,
            })
            .pipe(
              Effect.mapError((cause) =>
                engineError(cause, "Plakk could not prepare the storage upload.", true),
              ),
            );
          const heartbeatLoop = Effect.sleep("20 seconds").pipe(
            Effect.andThen(
              remote
                .heartbeat(account.accessToken, uploadEntry.id)
                .pipe(
                  Effect.mapError((cause) =>
                    engineError(cause, "Plakk could not keep this upload active.", true),
                  ),
                ),
            ),
            Effect.forever,
          );
          return yield* Effect.raceFirst(
            storage
              .upload(
                {
                  id: uploadEntry.id,
                  byteSize: uploadEntry.byteSize,
                  prepared,
                  filePath,
                },
                (progress) => {
                  progressById.set(uploadEntry.id, progress);
                  publishFromCallback(account.id);
                },
              )
              .pipe(
                Effect.mapError((cause) =>
                  engineError(cause, "The storage upload did not complete.", true),
                ),
              ),
            heartbeatLoop,
          );
        }).pipe(
          Effect.retry({
            schedule: Schedule.exponential("1 second"),
            times: 2,
            while: isTransientUploadFailure,
          }),
        );
        const uploaded = yield* transfer;
        const completed = yield* remote
          .complete(account.accessToken, {
            id: entry.id,
            storageObjectId: uploaded.storageObjectId,
          })
          .pipe(
            Effect.mapError((cause) =>
              engineError(cause, "Plakk could not confirm the completed upload.", true),
            ),
            Effect.retry({
              schedule: Schedule.exponential("1 second"),
              times: 2,
              while: isTransientUploadFailure,
            }),
          );
        yield* put(account.id, {
          ...entry,
          phase: "UPLOADED",
          progress: 100,
          storageObjectId: completed.storageObjectId,
          authoritativeStatus: completed.uploadStatus,
          errorMessage: null,
          canRetry: false,
          updatedAt: completed.updatedAt,
        });
        progressById.delete(entry.id);
      });

      const schedule = Effect.fn("SnippetUploadEngine.schedule")(function* (
        account: UploadAccount,
        snippetId: string,
      ) {
        if (active.has(snippetId)) return;
        active.set(snippetId, null);
        const work = concurrency
          .withPermit(
            runEntry(account, snippetId).pipe(
              Effect.catch((cause) =>
                markFailed(
                  account,
                  snippetId,
                  engineError(cause, "This snippet could not be uploaded.", true),
                ),
              ),
            ),
          )
          .pipe(
            Effect.ensuring(
              Effect.sync(() => {
                active.delete(snippetId);
              }),
            ),
          );
        const fiber = yield* Effect.forkDetach(work);
        if (active.has(snippetId)) active.set(snippetId, fiber);
      });

      const scheduleQueued = Effect.fn("SnippetUploadEngine.scheduleQueued")(function* (
        account: UploadAccount,
      ) {
        const entries = yield* outbox
          .list(account.id)
          .pipe(Effect.mapError((cause) => engineError(cause, cause.reason, false)));
        yield* Effect.forEach(
          entries.filter((entry) => entry.phase === "QUEUED"),
          (entry) => schedule(account, entry.id),
          { discard: true },
        );
      });

      const ingest = Effect.fn("SnippetUploadEngine.ingest")(function* (
        accountId: string,
        input: SnippetIngestPayload,
      ) {
        if (imports.has(input.id)) {
          return yield* new SnippetUploadEngineError({
            cause: null,
            reason: "This snippet is already being saved locally.",
            canRetry: false,
          });
        }
        const createdAt = DateTime.formatIso(yield* DateTime.now);
        const cancellation = yield* Deferred.make<void>();
        imports.set(input.id, {
          accountId,
          input,
          createdAt,
          localTextContent: localTextFrom(input),
        });
        importCancellations.set(input.id, cancellation);
        yield* publish(accountId);

        const imported = content.ingest(accountId, input).pipe(
          Effect.mapError((cause) => engineError(cause, cause.reason, false)),
          Effect.flatMap(() =>
            put(accountId, {
              id: input.id,
              fileName: input.fileName,
              byteSize: input.byteSize,
              mediaType: input.mediaType,
              storageProvider: input.storageProvider,
              phase: "QUEUED",
              progress: 0,
              storageObjectId: null,
              authoritativeStatus: null,
              errorMessage: null,
              canRetry: false,
              createdAt,
              updatedAt: createdAt,
            }),
          ),
        );

        const cancelled = Deferred.await(cancellation).pipe(
          Effect.andThen(
            Effect.fail(
              new SnippetUploadEngineError({
                cause: null,
                reason: "Saving this snippet was stopped.",
                canRetry: false,
              }),
            ),
          ),
        );
        yield* Effect.raceFirst(imported, cancelled).pipe(
          Effect.onError(() =>
            content.discard(accountId, input.id).pipe(Effect.catch(() => Effect.void)),
          ),
          Effect.ensuring(
            Effect.sync(() => {
              imports.delete(input.id);
              importCancellations.delete(input.id);
            }).pipe(Effect.andThen(publish(accountId))),
          ),
        );
        const account = yield* Ref.get(currentAccount);
        if (account?.id === accountId) yield* schedule(account, input.id);
      });

      const resume = Effect.fn("SnippetUploadEngine.resume")(function* (account: UploadAccount) {
        const previous = yield* Ref.get(currentAccount);
        yield* Ref.set(currentAccount, account);
        if (previous?.id === account.id && previous.accessToken === account.accessToken) {
          yield* scheduleQueued(account);
          return;
        }
        const entries = yield* outbox
          .list(account.id)
          .pipe(Effect.mapError((cause) => engineError(cause, cause.reason, false)));
        yield* Effect.forEach(
          entries.filter((entry) => entry.phase === "UPLOADING"),
          (entry) =>
            Effect.gen(function* () {
              yield* remote.heartbeat(account.accessToken, entry.id).pipe(
                Effect.retry({
                  schedule: Schedule.exponential("1 second"),
                  times: 2,
                  while: isTransientUploadFailure,
                }),
              );
              const updatedAt = DateTime.formatIso(yield* DateTime.now);
              yield* put(account.id, {
                ...entry,
                phase: "QUEUED",
                errorMessage: null,
                canRetry: false,
                updatedAt,
              });
            }).pipe(
              Effect.catch((cause) =>
                markFailed(
                  account,
                  entry.id,
                  engineError(cause, "This upload was interrupted. Retry when you’re ready.", true),
                ),
              ),
            ),
          { discard: true },
        );
        yield* scheduleQueued(account);
      });

      const pause = Effect.gen(function* () {
        yield* Ref.set(currentAccount, null);
        const fibers = [...active.values()].filter((fiber) => fiber !== null);
        active.clear();
        yield* Effect.forEach(fibers, Fiber.interrupt, { discard: true });
      });

      const project = Effect.fn("SnippetUploadEngine.project")(function* (
        accountId: string,
        replicaItems: ReadonlyArray<ApiSnippet>,
      ) {
        const entries = yield* outbox
          .list(accountId)
          .pipe(Effect.mapError((cause) => engineError(cause, cause.reason, false)));
        const replicas = new Map(replicaItems.map((snippet) => [snippet.id, snippet]));
        const projected: Array<DesktopSnippet> = [];
        const importingIds = new Set<string>();

        for (const value of imports.values()) {
          if (value.accountId !== accountId) continue;
          importingIds.add(value.input.id);
          replicas.delete(value.input.id);
          projected.push(importProjection(value));
        }
        for (const entry of entries) {
          if (importingIds.has(entry.id)) continue;
          const replica = replicas.get(entry.id);
          replicas.delete(entry.id);
          const presentation = deriveSnippetPresentation({ fileName: entry.fileName });
          const needsText = presentation.type === "text" || presentation.type === "hyperlink";
          const bytes = needsText
            ? yield* content
                .get(accountId, entry.id)
                .pipe(Effect.mapError((cause) => engineError(cause, cause.reason, false)))
            : null;
          const contentAvailable = needsText
            ? bytes?.byteLength === entry.byteSize
            : yield* content
                .available(accountId, entry.id, entry.byteSize)
                .pipe(Effect.mapError((cause) => engineError(cause, cause.reason, false)));
          const localTextContent =
            contentAvailable && bytes !== null ? new TextDecoder().decode(bytes) : null;
          const projectedEntry = {
            ...entry,
            progress: progressById.get(entry.id) ?? entry.progress,
          };
          projected.push({
            id: entry.id,
            fileName: replica?.fileName ?? entry.fileName,
            byteSize: replica?.byteSize ?? entry.byteSize,
            storageProvider: replica?.storageProvider ?? entry.storageProvider,
            storageObjectId: replica?.storageObjectId ?? entry.storageObjectId,
            uploadStatus: replica?.uploadStatus ?? entry.authoritativeStatus,
            createdAt: replica?.createdAt ?? entry.createdAt,
            updatedAt: replica?.updatedAt ?? entry.updatedAt,
            localState: localState(projectedEntry),
            localTextContent,
            contentAvailable,
          });
        }
        for (const replica of replicas.values()) {
          const presentation = deriveSnippetPresentation({ fileName: replica.fileName });
          const needsText = presentation.type === "text" || presentation.type === "hyperlink";
          const bytes = needsText
            ? yield* content
                .get(accountId, replica.id)
                .pipe(Effect.mapError((cause) => engineError(cause, cause.reason, false)))
            : null;
          const contentAvailable = needsText
            ? bytes?.byteLength === replica.byteSize
            : yield* content
                .available(accountId, replica.id, replica.byteSize)
                .pipe(Effect.mapError((cause) => engineError(cause, cause.reason, false)));
          const localTextContent =
            contentAvailable && bytes !== null ? new TextDecoder().decode(bytes) : null;
          projected.push({
            ...replica,
            localState: null,
            localTextContent,
            contentAvailable,
          });
        }
        return projected.sort((left, right) => right.createdAt.localeCompare(left.createdAt));
      });

      const cancel = Effect.fn("SnippetUploadEngine.cancel")(function* (
        account: UploadOwner,
        snippetId: string,
      ) {
        const importCancellation = importCancellations.get(snippetId);
        if (importCancellation !== undefined) {
          yield* Deferred.succeed(importCancellation, undefined);
          return;
        }
        const fiber = active.get(snippetId);
        if (fiber !== undefined && fiber !== null) yield* Fiber.interrupt(fiber);
        active.delete(snippetId);
        yield* markFailed(
          account,
          snippetId,
          new SnippetUploadEngineError({
            cause: null,
            reason: "Upload stopped. Retry when you’re ready.",
            canRetry: true,
          }),
        );
      });

      const retry = Effect.fn("SnippetUploadEngine.retry")(function* (
        account: UploadOwner,
        snippetId: string,
      ) {
        const entry = yield* outbox
          .get(account.id, snippetId)
          .pipe(Effect.mapError((cause) => engineError(cause, cause.reason, false)));
        if (entry === null || entry.phase !== "FAILED" || !entry.canRetry) return;
        let authoritativeStatus = entry.authoritativeStatus;
        if (authoritativeStatus !== null) {
          if (account.accessToken === null) return;
          if (authoritativeStatus === "UPLOADING") {
            const failed = yield* remote
              .fail(account.accessToken, snippetId)
              .pipe(
                Effect.mapError((cause) =>
                  engineError(cause, "Plakk could not reconcile the interrupted upload.", true),
                ),
              );
            authoritativeStatus = failed.uploadStatus;
          }
          const retried = yield* remote
            .retry(account.accessToken, snippetId)
            .pipe(
              Effect.mapError((cause) =>
                engineError(cause, "Plakk could not restart this upload.", true),
              ),
            );
          authoritativeStatus = retried.uploadStatus;
        }
        const now = DateTime.formatIso(yield* DateTime.now);
        yield* put(account.id, {
          ...entry,
          phase: "QUEUED",
          progress: 0,
          authoritativeStatus,
          errorMessage: null,
          canRetry: false,
          updatedAt: now,
        });
        const activeAccount = yield* Ref.get(currentAccount);
        if (activeAccount?.id === account.id) yield* schedule(activeAccount, snippetId);
      });

      const discard = Effect.fn("SnippetUploadEngine.discard")(function* (
        accountId: string,
        snippetId: string,
      ) {
        const fiber = active.get(snippetId);
        if (fiber !== undefined && fiber !== null) yield* Fiber.interrupt(fiber);
        active.delete(snippetId);
        progressById.delete(snippetId);
        yield* outbox
          .remove(accountId, snippetId)
          .pipe(Effect.mapError((cause) => engineError(cause, cause.reason, false)));
        yield* content
          .discard(accountId, snippetId)
          .pipe(Effect.mapError((cause) => engineError(cause, cause.reason, false)));
        yield* publish(accountId);
      });

      const remove = Effect.fn("SnippetUploadEngine.delete")(function* (
        account: UploadOwner,
        snippetId: string,
      ) {
        const entry = yield* outbox
          .get(account.id, snippetId)
          .pipe(Effect.mapError((cause) => engineError(cause, cause.reason, false)));
        const safelyLocalOnly =
          entry !== null && entry.phase === "QUEUED" && entry.authoritativeStatus === null;
        if (account.accessToken !== null) {
          yield* remote
            .delete(account.accessToken, snippetId)
            .pipe(
              Effect.mapError((cause) =>
                engineError(cause, "Plakk could not delete this snippet.", true),
              ),
            );
        } else if (!safelyLocalOnly) {
          return yield* new SnippetUploadEngineError({
            cause: null,
            reason: "Reconnect before deleting this snippet.",
            canRetry: true,
          });
        }
        yield* discard(account.id, snippetId);
      });

      const reconcile = Effect.fn("SnippetUploadEngine.reconcile")(function* (
        accountId: string,
        replicaItems: ReadonlyArray<ApiSnippet>,
      ) {
        const uploaded = new Set(
          replicaItems
            .filter((snippet) => snippet.uploadStatus === "UPLOADED")
            .map((snippet) => snippet.id),
        );
        const entries = yield* outbox
          .list(accountId)
          .pipe(Effect.mapError((cause) => engineError(cause, cause.reason, false)));
        const adopted = entries.filter((entry) => uploaded.has(entry.id));
        yield* Effect.forEach(
          adopted,
          (entry) => {
            const fiber = active.get(entry.id);
            active.delete(entry.id);
            progressById.delete(entry.id);
            return (
              fiber === undefined || fiber === null ? Effect.void : Fiber.interrupt(fiber)
            ).pipe(
              Effect.andThen(
                outbox
                  .remove(accountId, entry.id)
                  .pipe(Effect.mapError((cause) => engineError(cause, cause.reason, false))),
              ),
            );
          },
          { discard: true },
        );
        if (adopted.length > 0) yield* publish(accountId);
      });

      return SnippetUploadEngine.of({
        cancel,
        changes: Stream.fromPubSub(changes),
        delete: remove,
        discard,
        ingest,
        pause,
        project,
        reconcile,
        resume,
        retry,
      });
    }),
  );
}
