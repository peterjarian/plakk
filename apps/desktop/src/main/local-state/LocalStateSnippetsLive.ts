import { Effect, Layer, Schema, Stream } from "effect";

import { DesktopSnippetSchema } from "../../ipc/contracts.ts";
import { projectDesktopManagedContent } from "../snippets/SnippetProjection.ts";
import { ManagedSnippetContent } from "../snippets/content/ManagedSnippetContent.ts";
import { SnippetHydrationEngine } from "../snippets/hydration/SnippetHydration.ts";
import { SnippetReplica } from "../snippets/replica/SnippetReplica.ts";
import { LocalStateError } from "./LocalState.ts";
import { LocalStateSnippets, type LocalStateSnippetsShape } from "./LocalStateSnippets.ts";

const makeLocalStateSnippets = Effect.gen(function* () {
  const replica = yield* SnippetReplica;
  const hydration = yield* SnippetHydrationEngine;
  const managedContent = yield* ManagedSnippetContent;

  const changes = Stream.merge(
    replica.changes.pipe(Stream.map(({ accountId }) => accountId)),
    Stream.merge(hydration.changes, managedContent.changes, { haltStrategy: "both" }),
    { haltStrategy: "both" },
  );
  const read = Effect.fn("LocalStateSnippets.read")(function* (accountId: string) {
    const records = (yield* replica.get(accountId))?.items ?? [];
    const reconciledAvailability = yield* hydration.reconcile(accountId);
    const materialized = yield* Effect.forEach(records, (record) => {
      const item =
        record.kind === "LOCAL"
          ? {
              kind: "LOCAL" as const,
              id: record.id,
              fileName: record.fileName,
              byteSize: record.byteSize,
              storageProvider: record.storageProvider,
              createdAt: record.createdAt,
              updatedAt: record.updatedAt,
              localState: {
                status: record.status,
                errorMessage: record.errorMessage,
              },
            }
          : (() => {
              const { storageObjectId: _storageObjectId, ...snippet } = record.snippet;
              return { ...snippet, kind: "PUBLISHED" as const, localState: null };
            })();
      const availability =
        record.kind === "LOCAL"
          ? managedContent
              .available(accountId, record.id, record.byteSize)
              .pipe(
                Effect.map((available) =>
                  available
                    ? ({ status: "AVAILABLE" } as const)
                    : ({ status: "NOT_AVAILABLE" } as const),
                ),
              )
          : reconciledAvailability.get(item.id) === undefined
            ? hydration.state(accountId, item.id, item.byteSize)
            : Effect.succeed(reconciledAvailability.get(item.id)!);
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
    storageUsageBytes: (accountId) =>
      managedContent.storageUsageBytes(accountId).pipe(
        Effect.mapError(
          (cause) =>
            new LocalStateError({
              cause,
              reason: "Could not derive managed snippet storage usage.",
            }),
        ),
      ),
  } satisfies LocalStateSnippetsShape;
});

export const LocalStateSnippetsLive = Layer.effect(LocalStateSnippets, makeLocalStateSnippets);
