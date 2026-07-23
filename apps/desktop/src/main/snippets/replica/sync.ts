import type { ApiSnippet } from "@plakk/shared/PlakkApi";
import { Cause, Effect, Stream } from "effect";

import { ManagedSnippetContent } from "../content/ManagedSnippetContent.ts";
import { SnippetRemoteTransport, type SnippetSyncAccount } from "./SnippetRemoteTransport.ts";
import {
  SnippetReplica,
  deviceSnippetRecordId,
  type DeviceSnippetRecord,
  type SnippetReplicaState,
} from "./SnippetReplica.ts";

export type LiveConnectionStatus = "CONNECTED" | "RECONNECTING";

const recordCreatedAt = (record: DeviceSnippetRecord) =>
  record.kind === "LOCAL" ? record.createdAt : record.snippet.createdAt;

const ordered = (items: Iterable<DeviceSnippetRecord>): ReadonlyArray<DeviceSnippetRecord> =>
  Array.from(items).sort((left, right) =>
    recordCreatedAt(right).localeCompare(recordCreatedAt(left)),
  );

export const reconcileSnippetSnapshot = (
  current: SnippetReplicaState | null,
  snapshot: ReadonlyArray<ApiSnippet>,
): { readonly state: SnippetReplicaState; readonly stalePublishedIds: ReadonlyArray<string> } => {
  const published = new Map(snapshot.map((snippet) => [snippet.id, snippet]));
  const local = (current?.items ?? []).filter(
    (record) => record.kind === "LOCAL" && !published.has(record.id),
  );
  const stalePublishedIds = (current?.items ?? [])
    .filter((record) => record.kind === "PUBLISHED" && !published.has(record.snippet.id))
    .map((record) => deviceSnippetRecordId(record));
  return {
    state: {
      items: ordered([
        ...Array.from(published.values(), (snippet) => ({
          kind: "PUBLISHED" as const,
          snippet,
        })),
        ...local,
      ]),
    },
    stalePublishedIds,
  };
};

export const syncSnippetReplica = Effect.fn("SnippetReplica.sync")(function* (
  account: SnippetSyncAccount,
) {
  const replica = yield* SnippetReplica;
  const content = yield* ManagedSnippetContent;
  const remote = yield* SnippetRemoteTransport;
  const snapshot = yield* remote.snapshot(account);
  let stalePublishedIds: ReadonlyArray<string> = [];
  const state = yield* replica.update(account.id, (current) => {
    const reconciled = reconcileSnippetSnapshot(current, snapshot);
    stalePublishedIds = reconciled.stalePublishedIds;
    return reconciled.state;
  });
  if (stalePublishedIds.length > 0) {
    yield* content.invalidate(account.id, stalePublishedIds).pipe(
      Effect.catchCause((cause) =>
        Effect.logWarning("Could not remove managed content absent from the Snippet snapshot", {
          cause,
        }),
      ),
    );
  }
  return state;
});

export const runSnippetReplicaSync = Effect.fn("SnippetReplica.run")(function* (
  account: SnippetSyncAccount,
  lifecycle: {
    readonly onConnectionStatus: (status: LiveConnectionStatus) => Effect.Effect<void>;
    readonly onConnected: Effect.Effect<void>;
    readonly onDisconnected: Effect.Effect<void>;
  } = {
    onConnectionStatus: () => Effect.void,
    onConnected: Effect.void,
    onDisconnected: Effect.void,
  },
  currentAccount: Effect.Effect<SnippetSyncAccount> = Effect.succeed(account),
) {
  const remote = yield* SnippetRemoteTransport;
  let status: LiveConnectionStatus | null = null;
  const publishStatus = Effect.fn("SnippetReplica.publishConnectionStatus")(function* (
    next: LiveConnectionStatus,
  ) {
    if (status === next) return;
    status = next;
    yield* lifecycle.onConnectionStatus(next);
  });

  while (true) {
    yield* publishStatus("RECONNECTING");
    const connectionAccount = yield* currentAccount;
    let receivedInitialInvalidation = false;
    yield* remote.invalidations(connectionAccount).pipe(
      Stream.runForEach(() =>
        Effect.gen(function* () {
          const isInitialInvalidation = !receivedInitialInvalidation;
          receivedInitialInvalidation = true;
          yield* syncSnippetReplica(yield* currentAccount);
          yield* publishStatus("CONNECTED");
          if (isInitialInvalidation) yield* lifecycle.onConnected;
        }),
      ),
      Effect.catchCause((cause) =>
        Effect.logWarning("Snippet invalidation stream disconnected", {
          cause: Cause.pretty(cause),
        }),
      ),
    );
    yield* publishStatus("RECONNECTING");
    yield* lifecycle.onDisconnected;
    yield* Effect.sleep("5 seconds");
  }
});
