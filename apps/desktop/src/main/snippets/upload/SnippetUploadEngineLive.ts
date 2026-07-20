import { decodeSnippetTextPreview, isTextSnippetFileName, isValidSnippetText } from "@plakk/shared";
import type { ApiSnippet } from "@plakk/shared/PlakkApi";
import { RpcError } from "@plakk/shared/RpcError";
import {
  DateTime,
  Deferred,
  Effect,
  Fiber,
  Layer,
  PubSub,
  Ref,
  Schedule,
  Semaphore,
  Stream,
} from "effect";
import { RpcClientError } from "effect/unstable/rpc/RpcClientError";

import type { DesktopSnippet, ResolvedSnippetIngestPayload } from "../../../ipc/contracts.ts";
import {
  ManagedSnippetContent,
  ManagedSnippetContentError,
} from "../content/ManagedSnippetContent.ts";
import { SnippetReplicaError } from "../replica/SnippetReplica.ts";
import {
  SnippetUploadOutbox,
  SnippetUploadOutboxError,
  type SnippetUploadOutboxEntry,
} from "./SnippetUploadOutbox.ts";
import { SnippetUploadRemote } from "./SnippetUploadRemote.ts";
import {
  SnippetUploadEngine,
  SnippetUploadEngineError,
  type SnippetUploadEngineFailure,
  type UploadAccount,
  type UploadOwner,
  type UploadProjectedSnippet,
} from "./SnippetUploadEngine.ts";
import { StorageUpload, StorageUploadError } from "./StorageUpload.ts";

type ImportProjection = {
  readonly accountId: string;
  readonly input: ResolvedSnippetIngestPayload;
  readonly createdAt: string;
  readonly localTextPreview: string | null;
};

const errorReason = (cause: unknown, fallback: string) =>
  cause instanceof SnippetUploadEngineError ||
  cause instanceof ManagedSnippetContentError ||
  cause instanceof SnippetReplicaError ||
  cause instanceof SnippetUploadOutboxError
    ? cause.reason
    : cause instanceof StorageUploadError
      ? cause.message
      : fallback;

const canRetry = (cause: unknown, fallback: boolean) =>
  cause instanceof SnippetUploadEngineError
    ? cause.canRetry
    : cause instanceof StorageUploadError
      ? cause.retryable
      : cause instanceof ManagedSnippetContentError ||
          cause instanceof SnippetReplicaError ||
          cause instanceof SnippetUploadOutboxError
        ? false
        : fallback;

const isTransientRemoteFailure = (cause: unknown) =>
  cause instanceof RpcClientError ||
  (cause instanceof RpcError && cause.code === "INTERNAL_SERVER_ERROR");

const isTransientStorageFailure = (cause: unknown) =>
  cause instanceof StorageUploadError && cause.retryable;

const isTransientFailure = (cause: unknown) =>
  isTransientRemoteFailure(cause) || isTransientStorageFailure(cause);

export const snippetUploadFailureMessage = (cause: SnippetUploadEngineFailure) =>
  errorReason(cause, "Plakk couldn’t save this snippet locally.");

const localTextFrom = (input: ResolvedSnippetIngestPayload): string | null => {
  if (!("bytes" in input)) return null;
  return isTextSnippetFileName(input.fileName) && isValidSnippetText(input.bytes)
    ? decodeSnippetTextPreview(input.bytes)
    : null;
};

const importProjection = (value: ImportProjection): UploadProjectedSnippet => ({
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
  importingContent: {
    localTextPreview: value.localTextPreview,
    localContentAvailability:
      value.localTextPreview === null
        ? ({ status: "NOT_AVAILABLE" } as const)
        : ({ status: "AVAILABLE" } as const),
  },
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

export const SnippetUploadEngineLive = Layer.effect(
  SnippetUploadEngine,
  Effect.gen(function* () {
    const content = yield* ManagedSnippetContent;
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
    const pendingDeletes = new Set<string>();

    const publish = (accountId: string) => PubSub.publish(changes, accountId);
    const publishFromCallback = (accountId: string) => Effect.runFork(publish(accountId));
    const pendingDeleteKey = (accountId: string, snippetId: string) => `${accountId}/${snippetId}`;

    const put = Effect.fn("SnippetUploadEngine.put")(function* (
      accountId: string,
      entry: SnippetUploadOutboxEntry,
    ) {
      yield* outbox.put(accountId, entry);
      yield* publish(accountId);
    });

    const markFailed = Effect.fn("SnippetUploadEngine.markFailed")(function* (
      account: UploadOwner,
      snippetId: string,
      failure: unknown,
      fallback: string,
      retryable: boolean,
    ) {
      const entry = yield* outbox.get(account.id, snippetId);
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
        errorMessage: errorReason(failure, fallback),
        canRetry: canRetry(failure, retryable),
        updatedAt: now,
      });
    });

    const runEntry = Effect.fn("SnippetUploadEngine.runEntry")(function* (
      account: UploadAccount,
      snippetId: string,
    ) {
      let entry = yield* outbox.get(account.id, snippetId);
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

      const filePath = yield* content.path(account.id, entry.id, entry.byteSize);

      if (entry.authoritativeStatus === null) {
        const created = yield* remote.create(account.accessToken, {
          id: entry.id,
          fileName: entry.fileName,
          byteSize: entry.byteSize,
          storageProvider: entry.storageProvider,
        });
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
        yield* remote.heartbeat(account.accessToken, uploadEntry.id);
        const prepared = yield* remote.prepare(account.accessToken, {
          snippetId: uploadEntry.id,
          mediaType: uploadEntry.mediaType,
        });
        const heartbeatLoop = Effect.sleep("20 seconds").pipe(
          Effect.andThen(remote.heartbeat(account.accessToken, uploadEntry.id)),
          Effect.forever,
        );
        return yield* Effect.raceFirst(
          storage.upload(
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
          ),
          heartbeatLoop,
        );
      }).pipe(
        Effect.retry({
          schedule: Schedule.exponential("1 second"),
          times: 2,
          while: isTransientFailure,
        }),
      );
      const uploaded = yield* transfer;
      const completed = yield* remote
        .complete(account.accessToken, {
          id: entry.id,
          storageObjectId: uploaded.storageObjectId,
        })
        .pipe(
          Effect.retry({
            schedule: Schedule.exponential("1 second"),
            times: 2,
            while: isTransientFailure,
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
              markFailed(account, snippetId, cause, "This snippet could not be uploaded.", true),
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
      const entries = yield* outbox.list(account.id);
      yield* Effect.forEach(
        entries.filter((entry) => entry.phase === "QUEUED"),
        (entry) => schedule(account, entry.id),
        { discard: true },
      );
    });

    const ingest = Effect.fn("SnippetUploadEngine.ingest")(function* (
      accountId: string,
      input: ResolvedSnippetIngestPayload,
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
        localTextPreview: localTextFrom(input),
      });
      importCancellations.set(input.id, cancellation);
      yield* publish(accountId);

      const imported = content.ingest(accountId, input).pipe(
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
      const entries = yield* outbox.list(account.id);
      yield* Effect.forEach(
        entries.filter((entry) => entry.phase === "UPLOADING"),
        (entry) =>
          Effect.gen(function* () {
            yield* remote.heartbeat(account.accessToken, entry.id).pipe(
              Effect.retry({
                schedule: Schedule.exponential("1 second"),
                times: 2,
                while: isTransientRemoteFailure,
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
                cause,
                "This upload was interrupted. Retry when you’re ready.",
                true,
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

    const purge = Effect.fn("SnippetUploadEngine.purge")(function* (accountId: string) {
      const account = yield* Ref.get(currentAccount);
      if (account?.id === accountId) yield* pause;
      for (const value of imports.values()) {
        if (value.accountId !== accountId) continue;
        const cancellation = importCancellations.get(value.input.id);
        if (cancellation !== undefined) yield* Deferred.succeed(cancellation, undefined);
        imports.delete(value.input.id);
        importCancellations.delete(value.input.id);
        progressById.delete(value.input.id);
      }
      const prefix = `${accountId}/`;
      for (const deleteKey of pendingDeletes) {
        if (deleteKey.startsWith(prefix)) pendingDeletes.delete(deleteKey);
      }
      yield* outbox.purge(accountId);
      yield* publish(accountId);
    });

    const project = Effect.fn("SnippetUploadEngine.project")(function* (
      accountId: string,
      replicaItems: ReadonlyArray<ApiSnippet>,
    ) {
      const entries = yield* outbox.list(accountId);
      const replicas = new Map(replicaItems.map((snippet) => [snippet.id, snippet]));
      const projected: Array<UploadProjectedSnippet> = [];
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
        });
      }
      for (const replica of replicas.values()) {
        projected.push({
          ...replica,
          localState: null,
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
        "Upload stopped. Retry when you’re ready.",
        true,
      );
    });

    const retry = Effect.fn("SnippetUploadEngine.retry")(function* (
      account: UploadOwner,
      snippetId: string,
    ) {
      const entry = yield* outbox.get(account.id, snippetId);
      if (entry === null || entry.phase !== "FAILED" || !entry.canRetry) return;
      let authoritativeStatus = entry.authoritativeStatus;
      if (authoritativeStatus !== null) {
        if (account.accessToken === null) return;
        if (authoritativeStatus === "UPLOADING") {
          const failed = yield* remote.fail(account.accessToken, snippetId);
          authoritativeStatus = failed.uploadStatus;
        }
        const retried = yield* remote.retry(account.accessToken, snippetId);
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

    const cleanupLocal = Effect.fn("SnippetUploadEngine.cleanupLocal")(function* (
      accountId: string,
      snippetId: string,
    ) {
      const fiber = active.get(snippetId);
      if (fiber !== undefined && fiber !== null) yield* Fiber.interrupt(fiber);
      active.delete(snippetId);
      progressById.delete(snippetId);
      yield* outbox.remove(accountId, snippetId);
      yield* content.discard(accountId, snippetId);
    });

    const discard = Effect.fn("SnippetUploadEngine.discard")(function* (
      accountId: string,
      snippetId: string,
    ) {
      yield* cleanupLocal(accountId, snippetId);
      yield* publish(accountId);
    });

    const removePublishedRecords = Effect.fn("SnippetUploadEngine.removePublishedRecords")(
      function* (accountId: string, snippetIds: ReadonlyArray<string>) {
        yield* Effect.forEach(
          snippetIds,
          (snippetId) => {
            const fiber = active.get(snippetId);
            active.delete(snippetId);
            progressById.delete(snippetId);
            return (
              fiber === undefined || fiber === null ? Effect.void : Fiber.interrupt(fiber)
            ).pipe(Effect.andThen(outbox.remove(accountId, snippetId)));
          },
          { discard: true },
        );
      },
    );

    const remove = Effect.fn("SnippetUploadEngine.delete")(function* (
      account: UploadOwner,
      snippetId: string,
    ) {
      const entry = yield* outbox.get(account.id, snippetId);
      const safelyLocalOnly =
        entry !== null && entry.phase === "QUEUED" && entry.authoritativeStatus === null;
      if (account.accessToken === null && !safelyLocalOnly) {
        return yield* new SnippetUploadEngineError({
          cause: null,
          reason: "Reconnect before deleting this snippet.",
          canRetry: true,
        });
      }
      const deleteKey = pendingDeleteKey(account.id, snippetId);
      if (pendingDeletes.has(deleteKey)) return;
      pendingDeletes.add(deleteKey);

      const release = Effect.sync(() => pendingDeletes.delete(deleteKey));
      if (account.accessToken !== null) {
        const fiber = active.get(snippetId);
        if (fiber !== undefined && fiber !== null) yield* Fiber.interrupt(fiber);
        active.delete(snippetId);
        progressById.delete(snippetId);
        yield* remote.delete(account.accessToken, snippetId).pipe(Effect.ensuring(release));
        if (entry !== null && entry.authoritativeStatus === null) {
          yield* cleanupLocal(account.id, snippetId);
          yield* publish(account.id);
        }
      } else {
        yield* discard(account.id, snippetId).pipe(Effect.ensuring(release));
      }
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
      const entries = yield* outbox.list(accountId);
      const retainedIds = new Set([
        ...entries.map((entry) => entry.id),
        ...replicaItems.map((snippet) => snippet.id),
      ]);
      for (const deleteKey of pendingDeletes) {
        const prefix = `${accountId}/`;
        if (deleteKey.startsWith(prefix) && !retainedIds.has(deleteKey.slice(prefix.length))) {
          pendingDeletes.delete(deleteKey);
        }
      }
      const adopted = entries.filter((entry) => uploaded.has(entry.id));
      yield* Effect.forEach(
        adopted,
        (entry) => {
          const fiber = active.get(entry.id);
          active.delete(entry.id);
          progressById.delete(entry.id);
          return (
            fiber === undefined || fiber === null ? Effect.void : Fiber.interrupt(fiber)
          ).pipe(Effect.andThen(outbox.remove(accountId, entry.id)));
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
      purge,
      reconcile,
      removePublishedRecords,
      resume,
      retry,
    });
  }),
);
