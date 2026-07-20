import { Effect, Layer, Schema, Stream } from "effect";

import { DesktopSnippetSchema } from "../../ipc/contracts.ts";
import { projectDesktopManagedContent } from "../snippets/SnippetProjection.ts";
import { ManagedSnippetContent } from "../snippets/content/ManagedSnippetContent.ts";
import { SnippetHydrationEngine } from "../snippets/hydration/SnippetHydration.ts";
import { SnippetReplica } from "../snippets/replica/SnippetReplica.ts";
import { SnippetUploadEngine } from "../snippets/upload/SnippetUploadEngine.ts";
import { LocalStateError } from "./LocalState.ts";
import { LocalStateSnippets, type LocalStateSnippetsShape } from "./LocalStateSnippets.ts";

const makeLocalStateSnippets = Effect.gen(function* () {
  const replica = yield* SnippetReplica;
  const uploads = yield* SnippetUploadEngine;
  const hydration = yield* SnippetHydrationEngine;
  const managedContent = yield* ManagedSnippetContent;

  const changes = Stream.merge(
    replica.changes.pipe(Stream.map(({ accountId }) => accountId)),
    Stream.merge(uploads.changes, hydration.changes, { haltStrategy: "both" }),
    { haltStrategy: "both" },
  );
  const read = Effect.fn("LocalStateSnippets.read")(function* (accountId: string) {
    const replicaItems = (yield* replica.get(accountId))?.items ?? [];
    yield* uploads.reconcile(accountId, replicaItems);
    const items = yield* uploads.project(accountId, replicaItems);
    const reconciledAvailability = yield* hydration.reconcile(accountId);
    const materialized = yield* Effect.forEach(items, (item) => {
      const reconciled = reconciledAvailability.get(item.id);
      const availability =
        reconciled === undefined
          ? hydration.state(accountId, item.id, item.byteSize)
          : Effect.succeed(reconciled);
      return availability.pipe(
        Effect.flatMap((hydrationState) =>
          projectDesktopManagedContent(accountId, item, hydrationState).pipe(
            Effect.provideService(ManagedSnippetContent, managedContent),
          ),
        ),
        Effect.catch((error) =>
          projectDesktopManagedContent(accountId, item, {
            status: "FAILED",
            message: error.reason,
          }).pipe(Effect.provideService(ManagedSnippetContent, managedContent)),
        ),
      );
    });
    return yield* Schema.decodeUnknownEffect(Schema.Array(DesktopSnippetSchema))(materialized);
  });

  return {
    changes,
    read: (accountId) =>
      read(accountId).pipe(
        Effect.mapError(
          (cause) =>
            new LocalStateError({
              cause,
              reason: "Could not materialize snippets for local state.",
            }),
        ),
      ),
  } satisfies LocalStateSnippetsShape;
});

export const LocalStateSnippetsLive = Layer.effect(LocalStateSnippets, makeLocalStateSnippets);
