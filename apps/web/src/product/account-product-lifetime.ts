import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FiberHandle from "effect/FiberHandle";
import * as Layer from "effect/Layer";

import {
  AccountProductReader,
  type AccountProductReadError,
  type AccountProductSnapshot,
} from "./product-reader.ts";

export type AccountProductState =
  | { readonly kind: "idle" }
  | { readonly kind: "loading"; readonly accountId: string }
  | {
      readonly kind: "failed";
      readonly accountId: string;
      readonly cause: AccountProductReadError;
    }
  | ({
      readonly kind: "ready";
      readonly accountId: string;
    } & AccountProductSnapshot);

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
      const readFiber = yield* FiberHandle.make<void, never>();
      let state: AccountProductState = { kind: "idle" };
      let activeAccountId: string | null = null;
      let generation = 0;
      const listeners = new Set<() => void>();

      const publish = (next: AccountProductState) => {
        state = next;
        for (const listener of listeners) listener();
      };

      const load = Effect.fn("AccountProductLifetime.load")(function* (accountId: string) {
        generation += 1;
        const loadGeneration = generation;
        activeAccountId = accountId;
        publish({ accountId, kind: "loading" });

        const work = reader.read.pipe(
          Effect.match({
            onFailure: (cause) => {
              if (generation === loadGeneration && activeAccountId === accountId) {
                publish({ accountId, cause, kind: "failed" });
              }
            },
            onSuccess: (snapshot) => {
              if (generation === loadGeneration && activeAccountId === accountId) {
                publish({ ...snapshot, accountId, kind: "ready" });
              }
            },
          }),
        );
        yield* FiberHandle.run(readFiber, work, { startImmediately: true });
      });

      const clear = Effect.gen(function* () {
        generation += 1;
        activeAccountId = null;
        publish({ kind: "idle" });
        yield* FiberHandle.clear(readFiber);
      });

      return AccountProductLifetime.of({
        clear,
        enter: (accountId) => (activeAccountId === accountId ? Effect.void : load(accountId)),
        getSnapshot: () => state,
        retry: Effect.suspend(() =>
          activeAccountId === null ? Effect.void : load(activeAccountId),
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
>(clear: Effect.Effect<void, ClearE, ClearR>, signOut: Effect.Effect<void, SignOutE, SignOutR>) {
  yield* clear;
  yield* signOut;
});
