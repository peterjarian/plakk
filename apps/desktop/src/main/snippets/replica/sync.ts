import type { ApiSnippet } from "@plakk/shared/PlakkApi";
import { Effect, Stream } from "effect";

import { ManagedSnippetContent } from "../content/ManagedSnippetContent.ts";
import { SnippetUploadEngine } from "../upload/SnippetUploadEngine.ts";
import { SnippetRemoteTransport, type SnippetSyncAccount } from "./SnippetRemoteTransport.ts";
import { SnippetReplica, type SnippetReplicaState } from "./SnippetReplica.ts";

export type LiveConnectionStatus = "CONNECTED" | "RECONNECTING";

const ordered = (items: Iterable<ApiSnippet>): ReadonlyArray<ApiSnippet> =>
  Array.from(items).sort((left, right) => right.createdAt.localeCompare(left.createdAt));

const isPublished = (snippet: ApiSnippet) => snippet.uploadStatus === "UPLOADED";

export const reconcileSnippetSnapshot = (
  current: SnippetReplicaState | null,
  snapshot: ReadonlyArray<ApiSnippet>,
): { readonly state: SnippetReplicaState; readonly stalePublishedIds: ReadonlyArray<string> } => {
  const published = new Map(snapshot.map((snippet) => [snippet.id, snippet]));
  const local = (current?.items ?? []).filter(
    (snippet) => !isPublished(snippet) && !published.has(snippet.id),
  );
  const stalePublishedIds = (current?.items ?? [])
    .filter((snippet) => isPublished(snippet) && !published.has(snippet.id))
    .map((snippet) => snippet.id);
  return {
    state: { items: ordered([...published.values(), ...local]) },
    stalePublishedIds,
  };
};

export const syncSnippetReplica = Effect.fn("SnippetReplica.sync")(function* (
  account: SnippetSyncAccount,
) {
  const replica = yield* SnippetReplica;
  const content = yield* ManagedSnippetContent;
  const uploads = yield* SnippetUploadEngine;
  const remote = yield* SnippetRemoteTransport;
  const snapshot = yield* remote.snapshot(account);
  const reconciled = reconcileSnippetSnapshot(yield* replica.get(account.id), snapshot);
  yield* replica.commit(account.id, reconciled.state);
  if (reconciled.stalePublishedIds.length > 0) {
    yield* Effect.all(
      [
        content.invalidate(account.id, reconciled.stalePublishedIds).pipe(
          Effect.catchCause((cause) =>
            Effect.logWarning("Could not remove managed content absent from the Snippet snapshot", {
              cause,
            }),
          ),
        ),
        uploads.removePublishedRecords(account.id, reconciled.stalePublishedIds).pipe(
          Effect.catchCause((cause) =>
            Effect.logWarning("Could not remove compatible upload records after reconciliation", {
              cause,
            }),
          ),
        ),
      ],
      { discard: true },
    );
  }
  return reconciled.state;
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
    let receivedInitialInvalidation = false;
    yield* remote.invalidations(account).pipe(
      Stream.runForEach(() =>
        Effect.gen(function* () {
          if (!receivedInitialInvalidation) {
            receivedInitialInvalidation = true;
            yield* lifecycle.onConnected;
          }
          yield* syncSnippetReplica(account);
          yield* publishStatus("CONNECTED");
        }),
      ),
      Effect.catchCause((cause) =>
        Effect.logWarning("Snippet invalidation stream disconnected", { cause }),
      ),
    );
    yield* publishStatus("RECONNECTING");
    yield* lifecycle.onDisconnected;
    yield* Effect.sleep("5 seconds");
  }
});
