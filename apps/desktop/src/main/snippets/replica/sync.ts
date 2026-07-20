import type { ApiSnippet } from "@plakk/shared/PlakkApi";
import { Effect, Stream } from "effect";

import { ManagedSnippetContent } from "../content/ManagedSnippetContent.ts";
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
  const remote = yield* SnippetRemoteTransport;
  const snapshot = yield* remote.snapshot(account);
  const reconciled = reconcileSnippetSnapshot(yield* replica.get(account.id), snapshot);
  if (reconciled.stalePublishedIds.length > 0) {
    yield* content.invalidate(account.id, reconciled.stalePublishedIds);
  }
  yield* replica.commit(account.id, reconciled.state, reconciled.stalePublishedIds);
  return reconciled.state;
});

export const runSnippetReplicaSync = Effect.fn("SnippetReplica.run")(function* (
  account: SnippetSyncAccount,
  lifecycle: {
    readonly onConnectionStatus: (status: LiveConnectionStatus) => Effect.Effect<void>;
    readonly onConnected: Effect.Effect<void>;
  } = { onConnectionStatus: () => Effect.void, onConnected: Effect.void },
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
    let connected = false;
    yield* remote.invalidations(account).pipe(
      Stream.runForEach(() =>
        Effect.gen(function* () {
          if (!connected) {
            connected = true;
            yield* publishStatus("CONNECTED");
            yield* lifecycle.onConnected;
          }
          yield* syncSnippetReplica(account).pipe(
            Effect.catchCause((cause) =>
              Effect.logWarning("Complete Snippet refresh failed", { cause }),
            ),
          );
        }),
      ),
      Effect.catchCause((cause) =>
        Effect.logWarning("Snippet invalidation stream disconnected", { cause }),
      ),
    );
    yield* publishStatus("RECONNECTING");
    yield* Effect.sleep("5 seconds");
  }
});
