import { DateTime, Effect, Fiber, Layer, Semaphore } from "effect";
import { RpcError } from "@plakk/shared/RpcError";

import type { ResolvedSnippetIngestPayload } from "../../../ipc/contracts.ts";
import {
  ManagedSnippetContent,
  ManagedSnippetContentError,
} from "../content/ManagedSnippetContent.ts";
import {
  SnippetReplica,
  SnippetReplicaError,
  deviceSnippetRecordId,
  type LocalUploadRecord,
} from "../replica/SnippetReplica.ts";
import { SnippetUploadRemote } from "./SnippetUploadRemote.ts";
import {
  SnippetUploadEngine,
  SnippetUploadEngineError,
  type SnippetUploadEngineFailure,
  type UploadAccount,
} from "./SnippetUploadEngine.ts";
import { StorageUpload, StorageUploadError } from "./StorageUpload.ts";

const errorReason = (cause: unknown, fallback: string) =>
  cause instanceof SnippetUploadEngineError ||
  cause instanceof ManagedSnippetContentError ||
  cause instanceof SnippetReplicaError
    ? cause.reason
    : cause instanceof StorageUploadError
      ? cause.message
      : cause instanceof RpcError
        ? cause.message
        : fallback;

export const snippetUploadFailureMessage = (cause: SnippetUploadEngineFailure) =>
  errorReason(cause, "Plakk couldn’t save this snippet locally.");

const interruptedMessage = "This upload was interrupted. Dismiss it and add the content again.";

export const SnippetUploadEngineLive = Layer.effect(
  SnippetUploadEngine,
  Effect.gen(function* () {
    const content = yield* ManagedSnippetContent;
    const replica = yield* SnippetReplica;
    const remote = yield* SnippetUploadRemote;
    const storage = yield* StorageUpload;
    const concurrency = yield* Semaphore.make(2);
    const active = new Map<string, Fiber.Fiber<void, unknown> | null>();
    const activatedAccounts = new Set<string>();

    const activeKey = (accountId: string, snippetId: string) => `${accountId}/${snippetId}`;

    const markFailed = Effect.fn("SnippetUploadEngine.markFailed")(function* (
      accountId: string,
      snippetId: string,
      failure: unknown,
      fallback: string,
    ) {
      const updatedAt = DateTime.formatIso(yield* DateTime.now);
      yield* replica.update(accountId, (current) => ({
        items: current.items.map((record) =>
          record.kind === "LOCAL" && record.id === snippetId
            ? {
                ...record,
                status: "FAILED" as const,
                errorMessage: errorReason(failure, fallback),
                updatedAt,
              }
            : record,
        ),
      }));
    });

    const runUpload = Effect.fn("SnippetUploadEngine.runUpload")(function* (
      account: UploadAccount,
      input: ResolvedSnippetIngestPayload,
    ) {
      const filePath = yield* content.path(account.id, input.id, input.byteSize);
      const prepared = yield* remote.prepare(account.accessToken, {
        id: input.id,
        fileName: input.fileName,
        byteSize: input.byteSize,
        storageProvider: input.storageProvider,
        mediaType: input.mediaType,
      });
      const uploaded = yield* storage.upload({
        id: input.id,
        byteSize: input.byteSize,
        prepared,
        filePath,
      });
      const published = yield* remote.publish(account.accessToken, {
        id: input.id,
        fileName: input.fileName,
        byteSize: input.byteSize,
        storageProvider: input.storageProvider,
        storageObjectId: uploaded.storageObjectId,
      });
      yield* replica.update(account.id, (current) => {
        const record = { kind: "PUBLISHED" as const, snippet: published };
        const hasIdentity = current.items.some(
          (item) => deviceSnippetRecordId(item) === published.id,
        );
        return {
          items: hasIdentity
            ? current.items.map((item) =>
                deviceSnippetRecordId(item) === published.id ? record : item,
              )
            : [record, ...current.items],
        };
      });
    });

    const launch = Effect.fn("SnippetUploadEngine.launch")(function* (
      account: UploadAccount,
      input: ResolvedSnippetIngestPayload,
    ) {
      const key = activeKey(account.id, input.id);
      if (active.has(key)) return;
      active.set(key, null);
      const work = concurrency
        .withPermit(
          runUpload(account, input).pipe(
            Effect.catch((cause) =>
              markFailed(
                account.id,
                input.id,
                cause,
                "This snippet could not be uploaded. Dismiss it and add the content again.",
              ),
            ),
            Effect.onInterrupt(() =>
              markFailed(account.id, input.id, null, interruptedMessage).pipe(
                Effect.catchCause((cause) =>
                  Effect.logWarning("Could not mark an interrupted upload as failed", { cause }),
                ),
              ),
            ),
          ),
        )
        .pipe(
          Effect.ensuring(
            Effect.sync(() => {
              active.delete(key);
            }),
          ),
        );
      const fiber = yield* Effect.forkDetach(work);
      if (active.has(key)) active.set(key, fiber);
    });

    const ingest = Effect.fn("SnippetUploadEngine.ingest")(function* (
      account: UploadAccount,
      input: ResolvedSnippetIngestPayload,
    ) {
      const createdAt = DateTime.formatIso(yield* DateTime.now);
      const local: LocalUploadRecord = {
        kind: "LOCAL",
        id: input.id,
        fileName: input.fileName,
        byteSize: input.byteSize,
        storageProvider: input.storageProvider,
        status: "UPLOADING",
        errorMessage: null,
        createdAt,
        updatedAt: createdAt,
      };
      let duplicate = false;
      yield* replica.update(account.id, (current) => {
        duplicate = current.items.some((record) => deviceSnippetRecordId(record) === input.id);
        return duplicate ? current : { items: [local, ...current.items] };
      });
      if (duplicate) {
        return yield* new SnippetUploadEngineError({
          cause: null,
          reason: "This snippet identity is already in use on this device.",
        });
      }

      yield* content.ingest(account.id, input).pipe(
        Effect.onError(() =>
          replica.remove(account.id, input.id).pipe(
            Effect.andThen(content.discard(account.id, input.id)),
            Effect.catchCause(() => Effect.void),
          ),
        ),
      );
      yield* launch(account, input);
    });

    const normalize = Effect.fn("SnippetUploadEngine.normalize")(function* (accountId: string) {
      if (activatedAccounts.has(accountId)) return;
      const updatedAt = DateTime.formatIso(yield* DateTime.now);
      yield* replica.update(accountId, (current) => ({
        items: current.items.map((record) =>
          record.kind === "LOCAL" && record.status === "UPLOADING"
            ? {
                ...record,
                status: "FAILED" as const,
                errorMessage: interruptedMessage,
                updatedAt,
              }
            : record,
        ),
      }));
      activatedAccounts.add(accountId);
    });

    const pause = Effect.gen(function* () {
      const fibers = [...active.values()].filter((fiber) => fiber !== null);
      yield* Effect.forEach(fibers, Fiber.interrupt, { discard: true });
    });

    const purge = Effect.fn("SnippetUploadEngine.purge")(function* (accountId: string) {
      const prefix = `${accountId}/`;
      const fibers = [...active.entries()].filter(([key]) => key.startsWith(prefix));
      yield* Effect.forEach(
        fibers,
        ([key, fiber]) => {
          active.delete(key);
          return fiber === null ? Effect.void : Fiber.interrupt(fiber);
        },
        { discard: true },
      );
      activatedAccounts.delete(accountId);
    });

    const discard = Effect.fn("SnippetUploadEngine.discard")(function* (
      accountId: string,
      snippetId: string,
    ) {
      const current = yield* replica.get(accountId);
      const record = current?.items.find((item) => deviceSnippetRecordId(item) === snippetId);
      if (record?.kind !== "LOCAL" || record.status !== "FAILED") return;
      yield* content.discard(accountId, snippetId);
      yield* replica.remove(accountId, snippetId);
    });

    return SnippetUploadEngine.of({ discard, ingest, normalize, pause, purge });
  }),
);
