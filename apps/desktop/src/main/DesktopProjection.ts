import { StorageProviderLiteral, UserSchema, type StorageProvider, type User } from "@plakk/shared";
import { SnippetHydrationEngine } from "@plakk/shared/SnippetHydration";
import { SnippetReplica } from "@plakk/shared/SnippetReplica";
import type { AccountStatus, PipeConnection } from "@plakk/shared/PlakkApi";
import ElectronStore from "electron-store";
import { Context, Effect, Layer, PubSub, Ref, Schema, Semaphore, Stream } from "effect";

import {
  DesktopProjectionSchema,
  DesktopSnippetSchema,
  type DesktopProjection as DesktopProjectionValue,
  type DesktopSnippet,
} from "../ipc/contracts.ts";
import { projectDesktopManagedContent } from "./SnippetProjection.ts";
import { SnippetUploadEngine } from "./SnippetUploadEngine.ts";
import { DesktopManagedSnippetContent } from "./ManagedSnippetContent.ts";

const CachedDesktopSessionSchema = Schema.Struct({
  account: UserSchema,
  provider: Schema.Struct({
    known: Schema.Boolean,
    value: Schema.NullOr(StorageProviderLiteral),
  }),
});

type CachedDesktopSession = typeof CachedDesktopSessionSchema.Type;
const StoredDesktopSessionCodec = Schema.fromJsonString(CachedDesktopSessionSchema);

export class DesktopProjectionError extends Schema.TaggedErrorClass<DesktopProjectionError>()(
  "DesktopProjectionError",
  { cause: Schema.Defect(), reason: Schema.String },
) {}

export class DesktopProjectionStore extends Context.Service<
  DesktopProjectionStore,
  {
    readonly load: Effect.Effect<CachedDesktopSession | null, DesktopProjectionError>;
    save(session: CachedDesktopSession | null): Effect.Effect<void, DesktopProjectionError>;
  }
>()("plakk/main/DesktopProjectionStore") {
  static layer(options: { readonly cwd?: string } = {}) {
    return Layer.effect(
      DesktopProjectionStore,
      Effect.gen(function* () {
        const store = yield* Effect.try({
          try: () =>
            new ElectronStore<{ session: string | null }>({
              clearInvalidConfig: true,
              defaults: { session: null },
              name: "desktop-projection",
              ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
            }),
          catch: (cause) =>
            new DesktopProjectionError({
              cause,
              reason: "Could not open the desktop projection store.",
            }),
        });

        const load = Effect.fn("DesktopProjectionStore.load")(function* () {
          const json = yield* Effect.try({
            try: () => store.get("session"),
            catch: (cause) =>
              new DesktopProjectionError({
                cause,
                reason: "Could not read the desktop projection store.",
              }),
          });
          if (json === null) return null;
          return yield* Schema.decodeEffect(StoredDesktopSessionCodec)(json).pipe(
            Effect.mapError(
              (cause) =>
                new DesktopProjectionError({
                  cause,
                  reason: "Stored desktop projection state is invalid.",
                }),
            ),
            Effect.catch((error) =>
              Effect.try({
                try: () => store.set("session", null),
                catch: (cause) =>
                  new DesktopProjectionError({
                    cause,
                    reason: "Could not recover the desktop projection store.",
                  }),
              }).pipe(
                Effect.tap(() =>
                  Effect.logWarning("Discarded an invalid cached desktop session", { error }),
                ),
                Effect.as(null),
              ),
            ),
          );
        });

        const save = Effect.fn("DesktopProjectionStore.save")(function* (
          session: CachedDesktopSession | null,
        ) {
          const json =
            session === null
              ? null
              : yield* Schema.encodeEffect(StoredDesktopSessionCodec)(session).pipe(
                  Effect.mapError(
                    (cause) =>
                      new DesktopProjectionError({
                        cause,
                        reason: "Desktop projection state is invalid.",
                      }),
                  ),
                );
          yield* Effect.try({
            try: () => store.set("session", json),
            catch: (cause) =>
              new DesktopProjectionError({
                cause,
                reason: "Could not save the desktop projection state.",
              }),
          });
        });

        return DesktopProjectionStore.of({ load: load(), save });
      }),
    );
  }

  static readonly Live = DesktopProjectionStore.layer();
}

export class DesktopSnippetProjector extends Context.Service<
  DesktopSnippetProjector,
  {
    readonly changes: Stream.Stream<string>;
    project(
      accountId: string,
    ): Effect.Effect<ReadonlyArray<DesktopSnippet>, DesktopProjectionError>;
  }
>()("plakk/main/DesktopSnippetProjector") {
  static readonly Live = Layer.effect(
    DesktopSnippetProjector,
    Effect.gen(function* () {
      const replica = yield* SnippetReplica;
      const uploads = yield* SnippetUploadEngine;
      const hydration = yield* SnippetHydrationEngine;
      const managedContent = yield* DesktopManagedSnippetContent;

      const changes = Stream.merge(
        replica.changes.pipe(Stream.map(({ accountId }) => accountId)),
        Stream.merge(uploads.changes, hydration.changes),
      );
      const project = Effect.fn("DesktopSnippetProjector.project")(function* (accountId: string) {
        const replicaItems = (yield* replica.get(accountId))?.items ?? [];
        yield* uploads.reconcile(accountId, replicaItems);
        const items = yield* uploads.project(accountId, replicaItems);
        const reconciledAvailability = yield* hydration.reconcile(accountId);
        const projected = yield* Effect.forEach(items, (item) => {
          const reconciled = reconciledAvailability.get(item.id);
          const availability =
            reconciled === undefined
              ? hydration.state(accountId, item.id, item.byteSize)
              : Effect.succeed(reconciled);
          return availability.pipe(
            Effect.flatMap((hydrationState) =>
              projectDesktopManagedContent(accountId, item, hydrationState).pipe(
                Effect.provideService(DesktopManagedSnippetContent, managedContent),
              ),
            ),
            Effect.catch((error) =>
              projectDesktopManagedContent(accountId, item, {
                status: "FAILED",
                message: error.reason,
              }).pipe(Effect.provideService(DesktopManagedSnippetContent, managedContent)),
            ),
          );
        });
        return yield* Schema.decodeUnknownEffect(Schema.Array(DesktopSnippetSchema))(projected);
      });

      return DesktopSnippetProjector.of({
        changes,
        project: (accountId) =>
          project(accountId).pipe(
            Effect.mapError(
              (cause) =>
                new DesktopProjectionError({
                  cause,
                  reason: "Could not materialize the desktop Snippet projection.",
                }),
            ),
          ),
      });
    }),
  );
}

export type DesktopProjectionUpdate =
  | { readonly kind: "offline"; readonly account: User }
  | {
      readonly kind: "online";
      readonly account: User;
      readonly accountStatus: AccountStatus;
      readonly connection: PipeConnection | null;
    }
  | { readonly kind: "signed-out" };

const emptyProjection = (): DesktopProjectionValue => ({
  revision: 0,
  account: null,
  provider: { known: false, value: null },
  capability: { status: "OFFLINE" },
  snippets: [],
});

const cachedSession = (
  account: User,
  provider: { readonly known: boolean; readonly value: StorageProvider | null },
): CachedDesktopSession => ({ account, provider });

export class DesktopProjection extends Context.Service<
  DesktopProjection,
  {
    readonly current: Effect.Effect<DesktopProjectionValue>;
    readonly changes: Stream.Stream<DesktopProjectionValue>;
    update(update: DesktopProjectionUpdate): Effect.Effect<void, DesktopProjectionError>;
    readonly refresh: Effect.Effect<void, DesktopProjectionError>;
  }
>()("plakk/main/DesktopProjection") {
  static readonly layer = Layer.effect(
    DesktopProjection,
    Effect.gen(function* () {
      const store = yield* DesktopProjectionStore;
      const snippets = yield* DesktopSnippetProjector;
      const persisted = yield* store.load;
      const initialItems = persisted === null ? [] : yield* snippets.project(persisted.account.id);
      const initial =
        persisted === null
          ? emptyProjection()
          : {
              revision: 0,
              account: persisted.account,
              provider: persisted.provider,
              capability: { status: "OFFLINE" } as const,
              snippets: initialItems,
            };
      yield* Schema.decodeUnknownEffect(DesktopProjectionSchema)(initial).pipe(
        Effect.mapError(
          (cause) =>
            new DesktopProjectionError({
              cause,
              reason: "The initial desktop projection is invalid.",
            }),
        ),
      );

      const state = yield* Ref.make<DesktopProjectionValue>(initial);
      const session = yield* Ref.make<CachedDesktopSession | null>(persisted);
      const changes = yield* PubSub.unbounded<DesktopProjectionValue>();
      const lock = yield* Semaphore.make(1);

      const publish = Effect.fn("DesktopProjection.publish")(function* (
        next: Omit<DesktopProjectionValue, "revision">,
      ) {
        const current = yield* Ref.get(state);
        const projected: DesktopProjectionValue = { ...next, revision: current.revision + 1 };
        yield* Schema.decodeUnknownEffect(DesktopProjectionSchema)(projected).pipe(
          Effect.mapError(
            (cause) =>
              new DesktopProjectionError({
                cause,
                reason: "The desktop projection is invalid.",
              }),
          ),
        );
        yield* Ref.set(state, projected);
        yield* PubSub.publish(changes, projected);
      });

      const projectSession = Effect.fn("DesktopProjection.projectSession")(function* (
        nextSession: CachedDesktopSession | null,
        capability: DesktopProjectionValue["capability"],
      ) {
        const projectedSnippets =
          nextSession === null ? [] : yield* snippets.project(nextSession.account.id);
        yield* publish({
          account: nextSession?.account ?? null,
          provider: nextSession?.provider ?? { known: false, value: null },
          capability,
          snippets: projectedSnippets,
        });
      });

      const update = Effect.fn("DesktopProjection.update")((input: DesktopProjectionUpdate) =>
        lock.withPermit(
          Effect.gen(function* () {
            if (input.kind === "signed-out") {
              yield* store.save(null);
              yield* Ref.set(session, null);
              yield* projectSession(null, { status: "OFFLINE" });
              return;
            }

            const currentSession = yield* Ref.get(session);
            const nextSession =
              input.kind === "online"
                ? cachedSession(input.account, {
                    known: true,
                    value: input.accountStatus.storageProvider,
                  })
                : currentSession?.account.id === input.account.id
                  ? cachedSession(input.account, currentSession.provider)
                  : cachedSession(input.account, { known: false, value: null });
            const capability =
              input.kind === "online"
                ? ({
                    status: "ONLINE",
                    account: input.accountStatus,
                    connection: input.connection,
                  } as const)
                : ({ status: "OFFLINE" } as const);
            yield* store.save(nextSession);
            yield* Ref.set(session, nextSession);
            yield* projectSession(nextSession, capability);
          }),
        ),
      );

      const refresh = lock.withPermit(
        Effect.gen(function* () {
          const current = yield* Ref.get(state);
          const currentSession = yield* Ref.get(session);
          yield* projectSession(currentSession, current.capability);
        }),
      );

      yield* snippets.changes.pipe(
        Stream.runForEach((accountId) =>
          Ref.get(session).pipe(
            Effect.flatMap((active) => (active?.account.id === accountId ? refresh : Effect.void)),
            Effect.catchCause((cause) =>
              Effect.logError("Could not refresh the desktop projection", { cause }),
            ),
          ),
        ),
        Effect.forkScoped,
      );

      return DesktopProjection.of({
        changes: Stream.fromPubSub(changes),
        current: Ref.get(state),
        refresh,
        update,
      });
    }),
  );
}
