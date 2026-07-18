import { SnippetRecoveryCleanupError, SnippetReplica } from "@plakk/shared/SnippetReplica";
import { Effect, Layer } from "effect";

import { SnippetUploadEngine } from "../SnippetUploadEngine.ts";

const makeSnippetReplicaWithUploadCleanup = Effect.gen(function* () {
  const replica = yield* SnippetReplica;
  const uploads = yield* SnippetUploadEngine;

  return SnippetReplica.of({
    changes: replica.changes,
    get: (accountId) => replica.get(accountId),
    commit: (accountId, state, deletedIds = []) =>
      uploads.removeTombstones(accountId, deletedIds).pipe(
        Effect.mapError(
          (cause) =>
            new SnippetRecoveryCleanupError({
              cause,
              reason: cause.reason,
            }),
        ),
        Effect.andThen(replica.commit(accountId, state, deletedIds)),
      ),
    purge: (accountId) => replica.purge(accountId),
    remove: (accountId, snippetId) => replica.remove(accountId, snippetId),
  });
});

export const SnippetReplicaWithUploadCleanupLive = Layer.effect(
  SnippetReplica,
  makeSnippetReplicaWithUploadCleanup,
);
