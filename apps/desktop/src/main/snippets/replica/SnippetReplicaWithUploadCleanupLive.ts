import { Effect, Layer } from "effect";

import { SnippetUploadEngine } from "../upload/SnippetUploadEngine.ts";
import { SnippetPublishedCleanupError, SnippetReplica } from "./SnippetReplica.ts";

const makeSnippetReplicaWithUploadCleanup = Effect.gen(function* () {
  const replica = yield* SnippetReplica;
  const uploads = yield* SnippetUploadEngine;

  return SnippetReplica.of({
    changes: replica.changes,
    get: (accountId) => replica.get(accountId),
    commit: (accountId, state, removedPublishedIds = []) =>
      uploads.removePublishedRecords(accountId, removedPublishedIds).pipe(
        Effect.mapError(
          (cause) =>
            new SnippetPublishedCleanupError({
              cause,
              reason: cause.reason,
            }),
        ),
        Effect.andThen(replica.commit(accountId, state)),
      ),
    purge: (accountId) => replica.purge(accountId),
    remove: (accountId, snippetId) => replica.remove(accountId, snippetId),
  });
});

export const SnippetReplicaWithUploadCleanupLive = Layer.effect(
  SnippetReplica,
  makeSnippetReplicaWithUploadCleanup,
);
