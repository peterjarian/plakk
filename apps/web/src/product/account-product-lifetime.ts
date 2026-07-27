import * as Context from "effect/Context";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as FiberHandle from "effect/FiberHandle";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";

import {
  AccountProductReader,
  type AccountProductReadError,
  type AccountProductSnapshot,
} from "./product-reader.ts";
import {
  AccountProductMirror,
  type AccountProductMirrorError,
  type LocalReadPerformance,
} from "./readable-mirror.ts";

const INITIAL_RECONNECT_DELAY_MILLIS = 1_000;
const MAX_RECONNECT_DELAY_MILLIS = 30_000;

export class AccountProductLifetimeInitializationFailure extends Data.TaggedError(
  "AccountProductLifetimeInitializationFailure",
)<{
  readonly cause: unknown;
}> {}

export type AccountProductState =
  | { readonly kind: "idle" }
  | { readonly kind: "loading"; readonly accountId: string }
  | {
      readonly kind: "failed";
      readonly accountId: string;
      readonly cause: AccountProductReadError | AccountProductLifetimeInitializationFailure;
    }
  | (AccountProductSnapshot & {
      readonly kind: "ready";
      readonly accountId: string;
      readonly apiAvailability: "available" | "checking";
      readonly liveConnection: "connected" | "reconnecting";
      readonly localReadPerformance: LocalReadPerformance;
    })
  | (AccountProductSnapshot & {
      readonly kind: "ready";
      readonly accountId: string;
      readonly apiAvailability: "unavailable";
      readonly cause: AccountProductReadError;
      readonly liveConnection: "connected" | "reconnecting";
      readonly localReadPerformance: LocalReadPerformance;
    });

export interface AccountProductLifetimeShape {
  readonly clear: Effect.Effect<void, AccountProductMirrorError>;
  readonly enter: (accountId: string) => Effect.Effect<void>;
  readonly getSnapshot: () => AccountProductState;
  readonly retry: Effect.Effect<void>;
  readonly subscribe: (listener: () => void) => () => void;
}

export class AccountProductLifetime extends Context.Service<
  AccountProductLifetime,
  AccountProductLifetimeShape
>()("@plakk/web/product/account-product-lifetime/AccountProductLifetime") {
  static readonly layer = Layer.effect(
    AccountProductLifetime,
    Effect.gen(function* () {
      const reader = yield* AccountProductReader;
      const mirror = yield* AccountProductMirror;
      const mirrorFiber = yield* FiberHandle.make<void, never>();
      const refreshFiber = yield* FiberHandle.make<void, never>();
      const synchronizationFiber = yield* FiberHandle.make<void, never>();
      let state: AccountProductState = { kind: "idle" };
      let activeAccountId: string | null = null;
      let generation = 0;
      let refreshSequence = 0;
      let liveConnection: "connected" | "reconnecting" = "reconnecting";
      let localReadPerformance = mirror.readPerformance;
      const listeners = new Set<() => void>();

      const publish = (next: AccountProductState) => {
        state = next;
        for (const listener of listeners) listener();
      };

      const isCurrent = (accountId: string, expectedGeneration: number) =>
        generation === expectedGeneration && activeAccountId === accountId;

      const publishLiveConnection = (
        accountId: string,
        expectedGeneration: number,
        next: "connected" | "reconnecting",
      ) => {
        if (!isCurrent(accountId, expectedGeneration)) return;
        liveConnection = next;
        if (state.kind !== "ready" || state.accountId !== accountId) {
          return;
        }
        publish({ ...state, liveConnection: next });
      };

      const refresh = Effect.fn("AccountProductLifetime.refresh")(function* (
        accountId: string,
        expectedGeneration: number,
      ) {
        refreshSequence += 1;
        const expectedRefreshSequence = refreshSequence;
        yield* reader.read.pipe(
          Effect.matchEffect({
            onFailure: (cause) =>
              Effect.sync(() => {
                if (
                  !isCurrent(accountId, expectedGeneration) ||
                  refreshSequence !== expectedRefreshSequence
                ) {
                  return;
                }
                if (state.kind === "ready" && state.accountId === accountId) {
                  publish({
                    account: state.account,
                    accountId,
                    apiAvailability: "unavailable",
                    cause,
                    kind: "ready",
                    liveConnection,
                    localReadPerformance,
                    snippets: state.snippets,
                  });
                  return;
                }
                publish({ accountId, cause, kind: "failed" });
              }),
            onSuccess: (snapshot) =>
              Effect.gen(function* () {
                if (
                  !isCurrent(accountId, expectedGeneration) ||
                  refreshSequence !== expectedRefreshSequence
                ) {
                  return;
                }
                const mirrorResult = yield* mirror.replace(snapshot).pipe(Effect.result);
                if (mirrorResult._tag === "Failure") {
                  localReadPerformance = "degraded";
                }
                if (
                  !isCurrent(accountId, expectedGeneration) ||
                  refreshSequence !== expectedRefreshSequence
                ) {
                  return;
                }
                publish({
                  ...snapshot,
                  accountId,
                  apiAvailability: "available",
                  kind: "ready",
                  liveConnection,
                  localReadPerformance,
                });
              }),
          }),
        );
      });

      const startRefresh = (accountId: string, expectedGeneration: number) =>
        FiberHandle.run(refreshFiber, refresh(accountId, expectedGeneration), {
          startImmediately: true,
        }).pipe(Effect.asVoid);

      const synchronize = Effect.fn("AccountProductLifetime.synchronize")(function* (
        accountId: string,
        expectedGeneration: number,
      ) {
        let reconnectDelayMillis = INITIAL_RECONNECT_DELAY_MILLIS;
        yield* startRefresh(accountId, expectedGeneration);
        while (isCurrent(accountId, expectedGeneration)) {
          let observedConnection = false;
          yield* reader.invalidations.pipe(
            Stream.runForEach(() => {
              observedConnection = true;
              reconnectDelayMillis = INITIAL_RECONNECT_DELAY_MILLIS;
              publishLiveConnection(accountId, expectedGeneration, "connected");
              return startRefresh(accountId, expectedGeneration);
            }),
            Effect.ignore,
          );
          publishLiveConnection(accountId, expectedGeneration, "reconnecting");
          if (!isCurrent(accountId, expectedGeneration)) return;
          const delayMillis = reconnectDelayMillis;
          if (!observedConnection) {
            reconnectDelayMillis = Math.min(reconnectDelayMillis * 2, MAX_RECONNECT_DELAY_MILLIS);
          }
          yield* Effect.sleep(delayMillis);
        }
      });

      const start = Effect.fn("AccountProductLifetime.start")(function* (accountId: string) {
        generation += 1;
        const synchronizationGeneration = generation;
        refreshSequence += 1;
        activeAccountId = accountId;
        liveConnection = "reconnecting";
        localReadPerformance = mirror.readPerformance;
        publish({ accountId, kind: "loading" });
        const mirrored = yield* mirror.read.pipe(Effect.result);
        if (mirrored._tag === "Failure") {
          localReadPerformance = "degraded";
        } else if (mirrored.success !== null && isCurrent(accountId, synchronizationGeneration)) {
          publish({
            ...mirrored.success,
            accountId,
            apiAvailability: "checking",
            kind: "ready",
            liveConnection,
            localReadPerformance,
          });
        }
        yield* FiberHandle.run(
          mirrorFiber,
          mirror.changes.pipe(
            Stream.runForEach(() =>
              mirror.read.pipe(
                Effect.match({
                  onFailure: () => {
                    localReadPerformance = "degraded";
                  },
                  onSuccess: (snapshot) => {
                    if (snapshot === null || !isCurrent(accountId, synchronizationGeneration)) {
                      return;
                    }
                    const current = state;
                    publish({
                      ...snapshot,
                      accountId,
                      apiAvailability:
                        current.kind === "ready" ? current.apiAvailability : "checking",
                      ...(current.kind === "ready" && current.apiAvailability === "unavailable"
                        ? { cause: current.cause }
                        : {}),
                      kind: "ready",
                      liveConnection,
                      localReadPerformance,
                    } as AccountProductState);
                  },
                }),
              ),
            ),
            Effect.ignore,
          ),
          { startImmediately: true },
        );
        yield* FiberHandle.run(
          synchronizationFiber,
          synchronize(accountId, synchronizationGeneration),
          { startImmediately: true },
        );
      });

      const clear = Effect.gen(function* () {
        generation += 1;
        refreshSequence += 1;
        activeAccountId = null;
        liveConnection = "reconnecting";
        publish({ kind: "idle" });
        yield* FiberHandle.clear(synchronizationFiber);
        yield* FiberHandle.clear(mirrorFiber);
        yield* FiberHandle.clear(refreshFiber);
        yield* mirror.purge;
      });

      return AccountProductLifetime.of({
        clear,
        enter: (accountId) =>
          Effect.suspend(() => (activeAccountId === accountId ? Effect.void : start(accountId))),
        getSnapshot: () => state,
        retry: Effect.suspend(() =>
          activeAccountId === null ? Effect.void : startRefresh(activeAccountId, generation),
        ),
        subscribe: (listener) => {
          listeners.add(listener);
          return () => listeners.delete(listener);
        },
      });
    }),
  );
}

export const clearProductThenSignOut = Effect.fn("AccountProductLifetime.signOut")(function* <
  ClearE,
  ClearR,
  SignOutE,
  SignOutR,
  RestoreR,
>(
  clear: Effect.Effect<void, ClearE, ClearR>,
  signOut: Effect.Effect<void, SignOutE, SignOutR>,
  restore: Effect.Effect<void, never, RestoreR>,
) {
  yield* clear;
  yield* signOut.pipe(Effect.catch((cause) => restore.pipe(Effect.andThen(Effect.fail(cause)))));
});
