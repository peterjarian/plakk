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
      readonly apiAvailability: "available";
      readonly liveConnection: "connected" | "reconnecting";
    })
  | (AccountProductSnapshot & {
      readonly kind: "ready";
      readonly accountId: string;
      readonly apiAvailability: "unavailable";
      readonly cause: AccountProductReadError;
      readonly liveConnection: "connected" | "reconnecting";
    });

export interface AccountProductLifetimeShape {
  readonly clear: Effect.Effect<void>;
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
      const synchronizationFiber = yield* FiberHandle.make<void, never>();
      let state: AccountProductState = { kind: "idle" };
      let activeAccountId: string | null = null;
      let generation = 0;
      let refreshSequence = 0;
      let liveConnection: "connected" | "reconnecting" = "reconnecting";
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
          Effect.match({
            onFailure: (cause) => {
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
                  snippets: state.snippets,
                });
                return;
              }
              publish({ accountId, cause, kind: "failed" });
            },
            onSuccess: (snapshot) => {
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
              });
            },
          }),
        );
      });

      const synchronize = Effect.fn("AccountProductLifetime.synchronize")(function* (
        accountId: string,
        expectedGeneration: number,
      ) {
        yield* refresh(accountId, expectedGeneration);
        while (isCurrent(accountId, expectedGeneration)) {
          yield* reader.invalidations.pipe(
            Stream.runForEach(() =>
              Effect.gen(function* () {
                publishLiveConnection(accountId, expectedGeneration, "connected");
                yield* refresh(accountId, expectedGeneration);
              }),
            ),
            Effect.catch(() => Effect.void),
          );
          publishLiveConnection(accountId, expectedGeneration, "reconnecting");
          if (!isCurrent(accountId, expectedGeneration)) return;
          yield* Effect.sleep("1 second");
        }
      });

      const start = Effect.fn("AccountProductLifetime.start")(function* (accountId: string) {
        generation += 1;
        const synchronizationGeneration = generation;
        refreshSequence += 1;
        activeAccountId = accountId;
        liveConnection = "reconnecting";
        publish({ accountId, kind: "loading" });
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
      });

      return AccountProductLifetime.of({
        clear,
        enter: (accountId) =>
          Effect.suspend(() => (activeAccountId === accountId ? Effect.void : start(accountId))),
        getSnapshot: () => state,
        retry: Effect.suspend(() =>
          activeAccountId === null ? Effect.void : refresh(activeAccountId, generation),
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
