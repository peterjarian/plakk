import * as Context from "effect/Context";
import * as Data from "effect/Data";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FiberHandle from "effect/FiberHandle";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";

import {
  accountTrialExpiryDelayMillis,
  accountWithBillingRestriction,
  type AccountStatus,
} from "@plakk/shared/PlakkApi";

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
  readonly refresh: Effect.Effect<void>;
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
      const trialExpiryFiber = yield* FiberHandle.make<void, never>();
      const refreshFiber = yield* FiberHandle.make<void, never>();
      const synchronizationFiber = yield* FiberHandle.make<void, never>();
      let state: AccountProductState = { kind: "idle" };
      let activeAccountId: string | null = null;
      let generation = 0;
      let refreshSequence = 0;
      let mirrorReadSequence = 0;
      let liveConnection: "connected" | "reconnecting" = "reconnecting";
      let localReadPerformance = mirror.readPerformance();
      const listeners = new Set<() => void>();

      const publish = (next: AccountProductState) => {
        state = next;
        for (const listener of listeners) listener();
      };

      const isCurrent = (accountId: string, expectedGeneration: number) =>
        generation === expectedGeneration && activeAccountId === accountId;

      const scheduleTrialExpiry = Effect.fn("AccountProductLifetime.scheduleTrialExpiry")(
        function* (accountId: string, expectedGeneration: number, account: AccountStatus) {
          const now = yield* DateTime.now;
          const delayMillis = accountTrialExpiryDelayMillis(account, DateTime.toEpochMillis(now));
          if (delayMillis === null) {
            yield* FiberHandle.clear(trialExpiryFiber);
            return;
          }
          const expectedEndsAt = DateTime.toEpochMillis(account.accessEntitlement.trialEndsAt);
          yield* FiberHandle.run(
            trialExpiryFiber,
            Effect.sleep(delayMillis).pipe(
              Effect.andThen(
                Effect.sync(() => {
                  if (
                    !isCurrent(accountId, expectedGeneration) ||
                    state.kind !== "ready" ||
                    state.accountId !== accountId ||
                    state.account.accessEntitlement.status !== "TRIAL_ACTIVE" ||
                    DateTime.toEpochMillis(state.account.accessEntitlement.trialEndsAt) !==
                      expectedEndsAt
                  ) {
                    return;
                  }
                  publish({
                    ...state,
                    account: accountWithBillingRestriction(state.account),
                  });
                }),
              ),
            ),
            { startImmediately: true },
          );
        },
      );

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
        yield* mirror
          .synchronize(
            reader.read.pipe(
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
                    yield* mirror.replace(snapshot).pipe(Effect.result);
                    localReadPerformance = mirror.readPerformance();
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
                    yield* scheduleTrialExpiry(accountId, expectedGeneration, snapshot.account);
                  }),
              }),
            ),
          )
          .pipe(
            Effect.catch(() =>
              Effect.sync(() => {
                localReadPerformance = mirror.readPerformance();
                if (
                  isCurrent(accountId, expectedGeneration) &&
                  state.kind === "ready" &&
                  state.accountId === accountId
                ) {
                  publish({ ...state, localReadPerformance });
                }
              }),
            ),
          );
      });

      const startRefresh = (accountId: string, expectedGeneration: number) =>
        FiberHandle.run(refreshFiber, refresh(accountId, expectedGeneration), {
          startImmediately: true,
        }).pipe(Effect.asVoid);

      const readMirror = Effect.fn("AccountProductLifetime.readMirror")(function* (
        accountId: string,
        expectedGeneration: number,
        change: "initial" | "purge" | "rebuild" | "replace",
      ) {
        mirrorReadSequence += 1;
        const expectedMirrorReadSequence = mirrorReadSequence;
        const mirrored = yield* mirror.read.pipe(Effect.result);
        if (
          !isCurrent(accountId, expectedGeneration) ||
          mirrorReadSequence !== expectedMirrorReadSequence
        ) {
          return;
        }
        localReadPerformance = mirror.readPerformance();
        if (mirrored._tag === "Failure") {
          if (state.kind === "ready" && state.accountId === accountId) {
            publish({ ...state, localReadPerformance });
          }
          return;
        }
        if (mirrored.success === null) {
          if (change === "initial") return;
          refreshSequence += 1;
          publish({ accountId, kind: "loading" });
          if (change === "purge") {
            yield* FiberHandle.clear(synchronizationFiber);
            yield* FiberHandle.clear(refreshFiber);
            return;
          }
          yield* startRefresh(accountId, expectedGeneration);
          return;
        }

        const current = state;
        const common = {
          ...mirrored.success,
          accountId,
          kind: "ready" as const,
          liveConnection,
          localReadPerformance,
        };
        if (current.kind === "ready" && current.apiAvailability === "unavailable") {
          publish({
            ...common,
            apiAvailability: "unavailable",
            cause: current.cause,
          });
          yield* scheduleTrialExpiry(accountId, expectedGeneration, mirrored.success.account);
          return;
        }
        publish({
          ...common,
          apiAvailability: current.kind === "ready" ? current.apiAvailability : "checking",
        });
        yield* scheduleTrialExpiry(accountId, expectedGeneration, mirrored.success.account);
      });

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
        localReadPerformance = mirror.readPerformance();
        publish({ accountId, kind: "loading" });
        yield* FiberHandle.clear(trialExpiryFiber);
        yield* FiberHandle.run(
          mirrorFiber,
          mirror.changes.pipe(
            Stream.runForEach((change) => readMirror(accountId, synchronizationGeneration, change)),
            Effect.ignore,
          ),
          { startImmediately: true },
        );
        yield* Effect.yieldNow;
        yield* readMirror(accountId, synchronizationGeneration, "initial");
        yield* FiberHandle.run(
          synchronizationFiber,
          synchronize(accountId, synchronizationGeneration),
          { startImmediately: true },
        );
      });

      const clear = Effect.gen(function* () {
        const previousAccountId = activeAccountId;
        generation += 1;
        refreshSequence += 1;
        activeAccountId = null;
        liveConnection = "reconnecting";
        yield* FiberHandle.clear(synchronizationFiber);
        yield* FiberHandle.clear(mirrorFiber);
        yield* FiberHandle.clear(trialExpiryFiber);
        yield* FiberHandle.clear(refreshFiber);
        const purgeResult = yield* mirror.purge.pipe(Effect.result);
        if (purgeResult._tag === "Failure") {
          if (previousAccountId !== null) {
            yield* start(previousAccountId);
          }
          return yield* purgeResult.failure;
        }
        publish({ kind: "idle" });
      });

      return AccountProductLifetime.of({
        clear,
        enter: (accountId) =>
          Effect.suspend(() => (activeAccountId === accountId ? Effect.void : start(accountId))),
        getSnapshot: () => state,
        refresh: Effect.suspend(() =>
          activeAccountId === null ? Effect.void : refresh(activeAccountId, generation),
        ),
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
