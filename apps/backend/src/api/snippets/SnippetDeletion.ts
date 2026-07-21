import { and, Drizzle, eq } from "@plakk/db";
import { snippets } from "@plakk/db/schema";
import { Context, Effect, Layer } from "effect";

import { StorageProviderService } from "../storage/StorageProvider.ts";
import { notifySnippetChanges } from "./snippetInvalidations.ts";

export class SnippetDeletion extends Context.Service<
  SnippetDeletion,
  {
    readonly delete: (ownerWorkosUserId: string, snippetId: string) => Effect.Effect<void>;
  }
>()("@plakk/backend/api/snippets/SnippetDeletion") {}

export const SnippetDeletionLive = Layer.effect(
  SnippetDeletion,
  Effect.gen(function* () {
    const drizzle = yield* Drizzle;
    const storage = yield* StorageProviderService;

    const deleteSnippet = Effect.fn("SnippetDeletion.delete")(function* (
      ownerWorkosUserId: string,
      snippetId: string,
    ) {
      const deleted = yield* drizzle.db
        .transaction((tx) =>
          Effect.gen(function* () {
            const [removed] = yield* tx
              .delete(snippets)
              .where(
                and(eq(snippets.id, snippetId), eq(snippets.ownerWorkosUserId, ownerWorkosUserId)),
              )
              .returning();
            if (removed !== undefined) yield* notifySnippetChanges(tx, ownerWorkosUserId);
            return removed;
          }),
        )
        .pipe(Effect.orDie);
      if (deleted === undefined) return;

      yield* storage
        .deleteObject({
          storageProvider: deleted.storageProvider,
          storageObjectId: deleted.storageObjectId,
          workosUserId: deleted.ownerWorkosUserId,
        })
        .pipe(
          Effect.catchCause((cause) =>
            Effect.logWarning("Could not delete orphaned provider content", {
              cause,
              snippetId: deleted.id,
              storageProvider: deleted.storageProvider,
            }),
          ),
        );
    });

    return SnippetDeletion.of({ delete: deleteSnippet });
  }),
);
