import { Context, Effect, Result, Schedule, Schema, Stream } from "effect";
import type { RpcClientError } from "effect/unstable/rpc/RpcClientError";

import {
  ApiSnippetSchema,
  SnippetChangeCursorSchema,
  type ApiSnippet,
  type PreparedStorageUpload,
  type SnippetChangePage,
} from "./api/PlakkApi.ts";
import type { RpcError } from "./api/RpcError.ts";
import { StorageProviderLiteral, type StorageProvider } from "./index.ts";

export const TextSnippetOutboxItemSchema = Schema.Struct({
  mutationId: Schema.String.check(Schema.isUUID()),
  snippetId: Schema.String.check(Schema.isUUID()),
  byteSize: Schema.Int.check(Schema.isGreaterThan(0)),
  storageProvider: Schema.NullOr(StorageProviderLiteral),
  storageObjectId: Schema.optionalKey(Schema.NullOr(Schema.String)),
  replacePreparationGeneration: Schema.optionalKey(
    Schema.NullOr(Schema.Int.check(Schema.isGreaterThanOrEqualTo(1))),
  ),
  createdAt: Schema.String,
  status: Schema.Literals(["QUEUED", "NEEDS_ACTION"] as const),
  errorMessage: Schema.NullOr(Schema.String),
});

export type TextSnippetOutboxItem = typeof TextSnippetOutboxItemSchema.Type;

export const LocalTextSnippetSchema = Schema.Struct({
  id: Schema.String.check(Schema.isUUID()),
  kind: Schema.Literal("TEXT"),
  fileName: Schema.String,
  byteSize: Schema.Int.check(Schema.isGreaterThan(0)),
  contentType: Schema.Literal("text/plain; charset=utf-8"),
  storageProvider: Schema.NullOr(StorageProviderLiteral),
  phase: Schema.Literals(["QUEUED", "NEEDS_ACTION"] as const),
  progress: Schema.Literal(0),
  storageObjectId: Schema.Null,
  errorMessage: Schema.NullOr(Schema.String),
  createdAt: Schema.String,
});

export type LocalTextSnippet = typeof LocalTextSnippetSchema.Type;

export const SnippetReplicaStateSchema = Schema.Struct({
  cursor: SnippetChangeCursorSchema,
  items: Schema.Array(ApiSnippetSchema),
  textOutbox: Schema.optionalKey(Schema.Array(TextSnippetOutboxItemSchema)),
  initialized: Schema.optionalKey(Schema.Boolean),
});

export type SnippetReplicaState = typeof SnippetReplicaStateSchema.Type;

export type SnippetSyncAccount = {
  readonly id: string;
  readonly accessToken: string;
};

export class SnippetReplicaError extends Schema.TaggedErrorClass<SnippetReplicaError>()(
  "SnippetReplicaError",
  { cause: Schema.Defect(), reason: Schema.String },
) {}

export class ManagedSnippetContentError extends Schema.TaggedErrorClass<ManagedSnippetContentError>()(
  "ManagedSnippetContentError",
  { cause: Schema.Defect(), reason: Schema.String },
) {}

export class TextSnippetUploadError extends Schema.TaggedErrorClass<TextSnippetUploadError>()(
  "TextSnippetUploadError",
  {
    actionable: Schema.Boolean,
    cause: Schema.optionalKey(Schema.Defect()),
    message: Schema.String,
    stalePreparation: Schema.optionalKey(Schema.Boolean),
  },
) {}

export class SnippetReplica extends Context.Service<
  SnippetReplica,
  {
    readonly changes: Stream.Stream<{
      readonly accountId: string;
      readonly items: ReadonlyArray<ApiSnippet>;
      readonly textOutbox: ReadonlyArray<TextSnippetOutboxItem>;
    }>;
    get(accountId: string): Effect.Effect<SnippetReplicaState | null, SnippetReplicaError>;
    modify(
      accountId: string,
      update: (state: SnippetReplicaState | null) => SnippetReplicaState,
    ): Effect.Effect<SnippetReplicaState, SnippetReplicaError>;
  }
>()("@plakk/shared/SnippetReplica") {}

export class ManagedSnippetContent extends Context.Service<
  ManagedSnippetContent,
  {
    get(
      accountId: string,
      snippetId: string,
      revision: string,
    ): Effect.Effect<Uint8Array | null, ManagedSnippetContentError>;
    put(
      accountId: string,
      snippetId: string,
      revision: string,
      bytes: Uint8Array,
    ): Effect.Effect<void, ManagedSnippetContentError>;
    invalidate(
      accountId: string,
      snippetIds: ReadonlyArray<string>,
    ): Effect.Effect<void, ManagedSnippetContentError>;
    removeRevision(
      accountId: string,
      snippetId: string,
      revision: string,
    ): Effect.Effect<void, ManagedSnippetContentError>;
  }
>()("@plakk/shared/SnippetReplica/ManagedSnippetContent") {}

type SnippetRemoteError = RpcError | RpcClientError;

export class SnippetRemoteTransport extends Context.Service<
  SnippetRemoteTransport,
  {
    snapshot(account: SnippetSyncAccount): Effect.Effect<SnippetReplicaState, SnippetRemoteError>;
    pull(
      account: SnippetSyncAccount,
      cursor: string,
    ): Effect.Effect<SnippetChangePage, SnippetRemoteError>;
    wakes(account: SnippetSyncAccount): Stream.Stream<void, SnippetRemoteError>;
  }
>()("@plakk/shared/SnippetReplica/SnippetRemoteTransport") {}

export class TextSnippetUploadTransport extends Context.Service<
  TextSnippetUploadTransport,
  {
    resolveStorageProvider(
      account: SnippetSyncAccount,
    ): Effect.Effect<StorageProvider, TextSnippetUploadError | SnippetRemoteError>;
    create(
      account: SnippetSyncAccount,
      item: TextSnippetOutboxItem & { readonly storageProvider: StorageProvider },
    ): Effect.Effect<ApiSnippet, TextSnippetUploadError | SnippetRemoteError>;
    prepare(
      account: SnippetSyncAccount,
      item: TextSnippetOutboxItem & { readonly storageProvider: StorageProvider },
    ): Effect.Effect<PreparedStorageUpload, TextSnippetUploadError | SnippetRemoteError>;
    heartbeat(
      account: SnippetSyncAccount,
      item: TextSnippetOutboxItem & { readonly storageProvider: StorageProvider },
    ): Effect.Effect<void, TextSnippetUploadError | SnippetRemoteError>;
    upload(
      item: TextSnippetOutboxItem & { readonly storageProvider: StorageProvider },
      bytes: Uint8Array,
      prepared: PreparedStorageUpload,
    ): Effect.Effect<string, TextSnippetUploadError>;
    complete(
      account: SnippetSyncAccount,
      item: TextSnippetOutboxItem & { readonly storageProvider: StorageProvider },
      storageObjectId: string,
    ): Effect.Effect<ApiSnippet, TextSnippetUploadError | SnippetRemoteError>;
    fail(
      account: SnippetSyncAccount,
      item: TextSnippetOutboxItem & { readonly storageProvider: StorageProvider },
      message: string,
    ): Effect.Effect<void, TextSnippetUploadError | SnippetRemoteError>;
  }
>()("@plakk/shared/SnippetReplica/TextSnippetUploadTransport") {}

const outboxItems = (state: SnippetReplicaState | null): ReadonlyArray<TextSnippetOutboxItem> =>
  state?.textOutbox ?? [];

const ordered = (items: Iterable<ApiSnippet>): ReadonlyArray<ApiSnippet> =>
  Array.from(items).sort((left, right) => {
    const leftLegacy = left.kind === "TEXT" && left.storageProvider === null;
    const rightLegacy = right.kind === "TEXT" && right.storageProvider === null;
    if (leftLegacy !== rightLegacy) return leftLegacy ? -1 : 1;
    return right.createdAt.localeCompare(left.createdAt);
  });

export const toLocalTextSnippet = (item: TextSnippetOutboxItem): LocalTextSnippet => ({
  id: item.snippetId,
  kind: "TEXT",
  fileName: `${item.snippetId}.txt`,
  byteSize: item.byteSize,
  contentType: "text/plain; charset=utf-8",
  storageProvider: item.storageProvider,
  phase: item.status,
  progress: 0,
  storageObjectId: null,
  errorMessage: item.errorMessage,
  createdAt: item.createdAt,
});

export const visibleSnippetItems = (
  state: SnippetReplicaState | null,
): ReadonlyArray<ApiSnippet | LocalTextSnippet> => {
  const authoritativeIds = new Set(state?.items.map((item) => item.id) ?? []);
  const localItems = outboxItems(state).filter(
    (item) => item.status === "NEEDS_ACTION" || !authoritativeIds.has(item.snippetId),
  );
  const localIds = new Set(localItems.map((item) => item.snippetId));
  return [
    ...localItems.map(toLocalTextSnippet),
    ...(state?.items.filter((item) => !localIds.has(item.id)) ?? []),
  ];
};

const updateOutbox = Effect.fn("SnippetReplica.updateTextOutbox")(function* (
  accountId: string,
  update: (items: ReadonlyArray<TextSnippetOutboxItem>) => ReadonlyArray<TextSnippetOutboxItem>,
) {
  const replica = yield* SnippetReplica;
  yield* replica.modify(accountId, (state) => {
    const base = state ?? { cursor: "", items: [], initialized: false };
    return { ...base, textOutbox: update(outboxItems(state)) };
  });
});

const rememberCompletedTextSnippet = Effect.fn("SnippetReplica.rememberCompletedTextSnippet")(
  function* (accountId: string, mutationId: string, snippet: ApiSnippet) {
    const replica = yield* SnippetReplica;
    yield* replica.modify(accountId, (state) => ({
      cursor: state?.cursor ?? "",
      items: ordered([...(state?.items.filter((item) => item.id !== snippet.id) ?? []), snippet]),
      textOutbox: outboxItems(state).filter((item) => item.mutationId !== mutationId),
      ...(state?.initialized === undefined ? {} : { initialized: state.initialized }),
    }));
  },
);

export const enqueueTextSnippet = Effect.fn("SnippetReplica.enqueueTextSnippet")(function* (
  accountId: string,
  item: TextSnippetOutboxItem,
  bytes: Uint8Array,
) {
  const content = yield* ManagedSnippetContent;
  if (bytes.byteLength !== item.byteSize) {
    return yield* new ManagedSnippetContentError({
      cause: null,
      reason: "Text snippet content does not match its queued metadata.",
    });
  }
  yield* content.put(accountId, item.snippetId, item.mutationId, bytes);
  yield* updateOutbox(accountId, (items) =>
    items.some((candidate) => candidate.mutationId === item.mutationId) ? items : [item, ...items],
  );
  return item;
});

const processTextSnippet = Effect.fn("SnippetReplica.processTextSnippet")(function* (
  account: SnippetSyncAccount,
  queued: TextSnippetOutboxItem,
) {
  const content = yield* ManagedSnippetContent;
  const transport = yield* TextSnippetUploadTransport;
  const provider = queued.storageProvider ?? (yield* transport.resolveStorageProvider(account));
  const item = { ...queued, storageProvider: provider };
  if (queued.storageProvider === null) {
    yield* updateOutbox(account.id, (items) =>
      items.map((candidate) => (candidate.mutationId === item.mutationId ? item : candidate)),
    );
  }

  const bytes = yield* content.get(account.id, item.snippetId, item.mutationId);
  if (bytes === null || bytes.byteLength !== item.byteSize) {
    return yield* new TextSnippetUploadError({
      actionable: true,
      message: "Queued text content is no longer available on this device.",
    });
  }

  const remote = yield* transport.create(account, item);
  if (remote.uploadStatus === "READY") {
    yield* content.put(account.id, item.snippetId, remote.updatedAt, bytes);
    yield* rememberCompletedTextSnippet(account.id, item.mutationId, remote);
    return;
  }

  const prepared = yield* transport.prepare(account, item);
  if (
    item.replacePreparationGeneration !== null &&
    item.replacePreparationGeneration !== undefined
  ) {
    yield* updateOutbox(account.id, (items) =>
      items.map((candidate) =>
        candidate.mutationId === item.mutationId
          ? { ...candidate, replacePreparationGeneration: null }
          : candidate,
      ),
    );
  }
  const storageObjectId =
    item.storageObjectId ??
    (yield* Effect.scoped(
      Effect.gen(function* () {
        yield* transport.heartbeat(account, item);
        yield* Effect.forever(
          Effect.sleep("20 seconds").pipe(
            Effect.andThen(transport.heartbeat(account, item)),
            Effect.catch((error) =>
              Effect.logWarning("Text snippet upload heartbeat paused", { error }),
            ),
          ),
        ).pipe(Effect.forkScoped);
        return yield* transport.upload(item, bytes, prepared).pipe(
          Effect.tapError((error) =>
            error.stalePreparation === true
              ? updateOutbox(account.id, (items) =>
                  items.map((candidate) =>
                    candidate.mutationId === item.mutationId
                      ? {
                          ...candidate,
                          replacePreparationGeneration: prepared.preparationGeneration ?? null,
                        }
                      : candidate,
                  ),
                )
              : Effect.void,
          ),
        );
      }),
    ));
  if (item.storageObjectId === null || item.storageObjectId === undefined) {
    yield* updateOutbox(account.id, (items) =>
      items.map((candidate) =>
        candidate.mutationId === item.mutationId ? { ...candidate, storageObjectId } : candidate,
      ),
    );
  }
  const completed = yield* transport.complete(account, item, storageObjectId);
  yield* content.put(account.id, item.snippetId, completed.updatedAt, bytes);
  yield* rememberCompletedTextSnippet(account.id, item.mutationId, completed);
});

export const processTextSnippetOutbox = Effect.fn("SnippetReplica.processTextSnippetOutbox")(
  function* (account: SnippetSyncAccount) {
    const replica = yield* SnippetReplica;
    const transport = yield* TextSnippetUploadTransport;
    const state = yield* replica.get(account.id);
    for (const queued of outboxItems(state)) {
      if (queued.status === "NEEDS_ACTION") {
        if (queued.storageProvider !== null) {
          yield* transport
            .fail(
              account,
              { ...queued, storageProvider: queued.storageProvider },
              queued.errorMessage ?? "Upload needs attention.",
            )
            .pipe(
              Effect.catch((error) =>
                Effect.logWarning("Could not publish text snippet failure", { error }),
              ),
            );
        }
        continue;
      }
      const result = yield* Effect.result(processTextSnippet(account, queued));
      if (Result.isSuccess(result)) continue;
      const failure = result.failure;
      const actionableMessage =
        failure._tag === "TextSnippetUploadError"
          ? failure.actionable
            ? failure.message
            : null
          : failure._tag === "RpcError" && failure.code === "FORBIDDEN"
            ? failure.message
            : null;
      if (actionableMessage === null) {
        if (
          failure._tag === "ManagedSnippetContentError" ||
          failure._tag === "SnippetReplicaError"
        ) {
          return yield* failure;
        }
        continue;
      }

      const latest = outboxItems(yield* replica.get(account.id)).find(
        (item) => item.mutationId === queued.mutationId,
      );
      const failed = {
        ...(latest ?? queued),
        status: "NEEDS_ACTION" as const,
        errorMessage: actionableMessage,
      };
      yield* updateOutbox(account.id, (items) =>
        items.map((candidate) => (candidate.mutationId === failed.mutationId ? failed : candidate)),
      );
      if (failed.storageProvider !== null) {
        yield* transport
          .fail(
            account,
            { ...failed, storageProvider: failed.storageProvider },
            failed.errorMessage,
          )
          .pipe(
            Effect.catch((error) =>
              Effect.logWarning("Could not publish text snippet failure", { error }),
            ),
          );
      }
    }
  },
);

export const runTextSnippetOutbox = Effect.fn("SnippetReplica.runTextSnippetOutbox")(function* (
  account: SnippetSyncAccount,
) {
  while (true) {
    yield* processTextSnippetOutbox(account).pipe(
      Effect.catch((error) =>
        Effect.logWarning("Text snippet outbox processing paused", { error }),
      ),
    );
    yield* Effect.sleep("5 seconds");
  }
});

export const retryTextSnippet = Effect.fn("SnippetReplica.retryTextSnippet")(function* (
  accountId: string,
  snippetId: string,
) {
  yield* updateOutbox(accountId, (items) =>
    items.map((item) =>
      item.snippetId === snippetId ? { ...item, status: "QUEUED", errorMessage: null } : item,
    ),
  );
});

export const discardTextSnippet = Effect.fn("SnippetReplica.discardTextSnippet")(function* (
  accountId: string,
  snippetId: string,
) {
  const content = yield* ManagedSnippetContent;
  yield* updateOutbox(accountId, (items) => items.filter((item) => item.snippetId !== snippetId));
  yield* content.invalidate(accountId, [snippetId]);
});

const applyChanges = (
  items: ReadonlyArray<ApiSnippet>,
  page: Extract<SnippetChangePage, { readonly status: "OK" }>,
): ReadonlyArray<ApiSnippet> => {
  const next = new Map(items.map((snippet) => [snippet.id, snippet]));
  for (const change of page.changes) {
    if (change.type === "DELETE") next.delete(change.snippetId);
    else next.set(change.snippet.id, change.snippet);
  }
  return ordered(next.values());
};

const replaceWithSnapshot = Effect.fn("SnippetReplica.replaceWithSnapshot")(function* (
  accountId: string,
  current: SnippetReplicaState | null,
  snapshot: SnippetReplicaState,
) {
  const replica = yield* SnippetReplica;
  const content = yield* ManagedSnippetContent;
  const fresh = new Map(snapshot.items.map((snippet) => [snippet.id, snippet]));
  const staleRevisions =
    current?.items
      .filter((snippet) => fresh.get(snippet.id)?.updatedAt !== snippet.updatedAt)
      .map((snippet) => ({ snippetId: snippet.id, revision: snippet.updatedAt })) ?? [];
  yield* Effect.forEach(
    staleRevisions,
    ({ revision, snippetId }) => content.removeRevision(accountId, snippetId, revision),
    { discard: true },
  );
  return yield* replica.modify(accountId, (latest) => {
    const latestOutbox = outboxItems(latest);
    return {
      cursor: snapshot.cursor,
      items: ordered(snapshot.items),
      ...(latestOutbox.length === 0 ? {} : { textOutbox: latestOutbox }),
    };
  });
});

export const syncSnippetReplica = Effect.fn("SnippetReplica.sync")(function* (
  account: SnippetSyncAccount,
) {
  const replica = yield* SnippetReplica;
  const content = yield* ManagedSnippetContent;
  const remote = yield* SnippetRemoteTransport;
  let state = yield* replica.get(account.id);

  if (state === null || state.initialized === false) {
    const snapshot = yield* remote.snapshot(account);
    state = yield* replaceWithSnapshot(account.id, null, snapshot);
  }

  while (true) {
    const page: SnippetChangePage = yield* remote.pull(account, state.cursor);
    if (page.status === "RESNAPSHOT_REQUIRED") {
      const snapshot = yield* remote.snapshot(account);
      state = yield* replaceWithSnapshot(account.id, state, snapshot);
      continue;
    }

    if (page.changes.length === 0) {
      if (page.nextCursor !== state.cursor) {
        const current: SnippetReplicaState = state;
        state = yield* replica.modify(account.id, (latest) => {
          const latestOutbox = outboxItems(latest);
          return {
            cursor: page.nextCursor,
            items: current.items,
            ...(latestOutbox.length === 0 ? {} : { textOutbox: latestOutbox }),
          };
        });
      }
      return;
    }

    const current: SnippetReplicaState = state;
    const deletedIds: ReadonlyArray<string> = page.changes.flatMap((change) =>
      change.type === "DELETE" ? [change.snippetId] : [],
    );
    const staleRevisions = page.changes.flatMap((change) => {
      if (change.type === "DELETE") return [];
      const existing = current.items.find((item) => item.id === change.snippet.id);
      return existing === undefined || existing.updatedAt === change.snippet.updatedAt
        ? []
        : [{ snippetId: existing.id, revision: existing.updatedAt }];
    });
    state = yield* replica.modify(account.id, (latest): SnippetReplicaState => {
      const retainedOutbox: ReadonlyArray<TextSnippetOutboxItem> = outboxItems(latest).filter(
        (item) => !deletedIds.includes(item.snippetId),
      );
      return {
        cursor: page.nextCursor,
        items: applyChanges(current.items, page),
        ...(retainedOutbox.length === 0 ? {} : { textOutbox: retainedOutbox }),
      };
    });
    if (deletedIds.length > 0) yield* content.invalidate(account.id, deletedIds);
    yield* Effect.forEach(
      staleRevisions,
      ({ revision, snippetId }) => content.removeRevision(account.id, snippetId, revision),
      { discard: true },
    );
  }
});

const syncAndKeepRunning = Effect.fn("SnippetReplica.syncAndKeepRunning")(function* (
  account: SnippetSyncAccount,
) {
  yield* syncSnippetReplica(account).pipe(
    Effect.catch((error) => Effect.logWarning("Snippet replica synchronization paused", { error })),
  );
});

export const runSnippetReplicaSync = Effect.fn("SnippetReplica.run")(function* (
  account: SnippetSyncAccount,
) {
  const remote = yield* SnippetRemoteTransport;
  const wakes = remote.wakes(account).pipe(
    Stream.tapError((error) =>
      Effect.logWarning("Snippet change wake stream disconnected", { error }),
    ),
    Stream.retry(Schedule.spaced("5 seconds")),
  );
  const healthChecks = Stream.fromSchedule(Schedule.spaced("30 seconds")).pipe(
    Stream.map(() => undefined),
  );

  yield* syncAndKeepRunning(account);
  yield* Stream.merge(wakes, healthChecks).pipe(
    Stream.runForEach(() => syncAndKeepRunning(account)),
  );
});
