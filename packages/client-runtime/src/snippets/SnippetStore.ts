import { Context, Effect, Layer, Stream, SubscriptionRef } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { CurrentSession } from "../CurrentSession.ts";
import { LocalStorageError } from "../models/ClientError.ts";
import { listSnippets } from "../sqlite/queries/snippets.ts";
import type { Snippet } from "../models/Snippet.ts";

export type SnippetSubscriptionFailure = LocalStorageError;

export class SnippetStore extends Context.Service<
  SnippetStore,
  {
    /**
     * Subscribes to complete, newest-first local snippet snapshots.
     *
     * Every subscription emits the current SQLite snapshot first and then
     * emits a fresh snapshot after each committed snippet change.
     */
    readonly subscribe: () => Stream.Stream<ReadonlyArray<Snippet>, SnippetSubscriptionFailure>;
    /** Reloads SQLite after a committed snippet change and publishes the snapshot. */
    readonly refresh: Effect.Effect<void, SnippetSubscriptionFailure>;
  }
>()("@plakk/client-runtime/snippets/SnippetStore") {
  static readonly Live = Layer.effect(
    SnippetStore,
    Effect.gen(function* () {
      const session = yield* CurrentSession;
      const sql = yield* SqlClient.SqlClient;
      const current = listSnippets(session.user.id).pipe(
        Effect.provideService(SqlClient.SqlClient, sql),
        Effect.catchTags({
          SchemaError: () =>
            Effect.fail(
              new LocalStorageError({
                message: "Plakk could not read its local data.",
              }),
            ),
          SqlError: () =>
            Effect.fail(
              new LocalStorageError({
                message: "Plakk could not read its local data.",
              }),
            ),
        }),
      );
      const snapshots = yield* SubscriptionRef.make<ReadonlyArray<Snippet>>(yield* current);

      /** Returns the current snapshot followed by every committed refresh. */
      const subscribe = (): Stream.Stream<ReadonlyArray<Snippet>, SnippetSubscriptionFailure> =>
        SubscriptionRef.changes(snapshots);

      /** Reloads the authoritative SQLite state and publishes it atomically. */
      const refresh = current.pipe(
        Effect.flatMap((snapshot) => SubscriptionRef.set(snapshots, snapshot)),
      );

      return SnippetStore.of({ subscribe, refresh });
    }),
  );
}
