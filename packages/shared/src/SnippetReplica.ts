import { Context, Effect, Schedule, Schema, Stream } from "effect";
import type { RpcClientError } from "effect/unstable/rpc/RpcClientError";

import {
  ApiSnippetSchema,
  SnippetChangeCursorSchema,
  type ApiSnippet,
  type SnippetChangePage,
} from "./api/PlakkApi.ts";
import type { RpcError } from "./api/RpcError.ts";

export const SnippetReplicaStateSchema = Schema.Struct({
  cursor: SnippetChangeCursorSchema,
  items: Schema.Array(ApiSnippetSchema),
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

export class SnippetReplica extends Context.Service<
  SnippetReplica,
  {
    readonly changes: Stream.Stream<{
      readonly accountId: string;
      readonly items: ReadonlyArray<ApiSnippet>;
    }>;
    get(accountId: string): Effect.Effect<SnippetReplicaState | null, SnippetReplicaError>;
    commit(accountId: string, state: SnippetReplicaState): Effect.Effect<void, SnippetReplicaError>;
  }
>()("@plakk/shared/SnippetReplica") {}

export class ManagedSnippetContent extends Context.Service<
  ManagedSnippetContent,
  {
    get(
      accountId: string,
      snippetId: string,
    ): Effect.Effect<Uint8Array | null, ManagedSnippetContentError>;
    put(
      accountId: string,
      snippetId: string,
      bytes: Uint8Array,
    ): Effect.Effect<void, ManagedSnippetContentError>;
    invalidate(
      accountId: string,
      snippetIds: ReadonlyArray<string>,
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

const ordered = (items: Iterable<ApiSnippet>): ReadonlyArray<ApiSnippet> =>
  Array.from(items).sort((left, right) => right.createdAt.localeCompare(left.createdAt));

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
  const freshIds = new Set(snapshot.items.map((snippet) => snippet.id));
  const staleIds =
    current?.items.filter((snippet) => !freshIds.has(snippet.id)).map((snippet) => snippet.id) ??
    [];
  const normalized = { cursor: snapshot.cursor, items: ordered(snapshot.items) };
  yield* content.invalidate(accountId, staleIds);
  yield* replica.commit(accountId, normalized);
  return normalized;
});

export const syncSnippetReplica = Effect.fn("SnippetReplica.sync")(function* (
  account: SnippetSyncAccount,
) {
  const replica = yield* SnippetReplica;
  const content = yield* ManagedSnippetContent;
  const remote = yield* SnippetRemoteTransport;
  let state = yield* replica.get(account.id);

  if (state === null) {
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
        state = { ...state, cursor: page.nextCursor };
        yield* replica.commit(account.id, state);
      }
      return;
    }

    const deletedIds = page.changes.flatMap((change) =>
      change.type === "DELETE" ? [change.snippetId] : [],
    );
    if (deletedIds.length > 0) yield* content.invalidate(account.id, deletedIds);
    state = { cursor: page.nextCursor, items: applyChanges(state.items, page) };
    yield* replica.commit(account.id, state);
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
  const healthChecks = Stream.fromSchedule(Schedule.spaced("5 minutes")).pipe(
    Stream.map(() => undefined),
  );

  yield* syncAndKeepRunning(account);
  yield* Stream.merge(wakes, healthChecks).pipe(
    Stream.runForEach(() => syncAndKeepRunning(account)),
  );
});
