import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";

import type { AccountProductSnapshot } from "./product-reader.ts";

export type LocalReadPerformance = "accelerated" | "degraded";
export type AccountProductMirrorChange = "purge" | "rebuild" | "replace";

export class AccountProductMirrorError extends Schema.TaggedErrorClass<AccountProductMirrorError>()(
  "AccountProductMirrorError",
  {
    cause: Schema.Defect(),
    reason: Schema.String,
  },
) {}

export interface AccountProductMirrorShape {
  readonly changes: Stream.Stream<AccountProductMirrorChange>;
  readonly purge: Effect.Effect<void, AccountProductMirrorError>;
  readonly read: Effect.Effect<AccountProductSnapshot | null, AccountProductMirrorError>;
  readonly readPerformance: () => LocalReadPerformance;
  readonly replace: (
    snapshot: AccountProductSnapshot,
  ) => Effect.Effect<void, AccountProductMirrorError>;
  readonly synchronize: <A, E, R>(
    operation: Effect.Effect<A, E, R>,
  ) => Effect.Effect<A, E | AccountProductMirrorError, R>;
}

export class AccountProductMirror extends Context.Service<
  AccountProductMirror,
  AccountProductMirrorShape
>()("@plakk/web/product/readable-mirror/AccountProductMirror") {}

export const makeRuntimeFallbackAccountProductMirror = (
  primary: AccountProductMirrorShape,
): AccountProductMirrorShape => {
  let sessionSnapshot: AccountProductSnapshot | null = null;
  let useSessionMemory = false;

  const read = Effect.suspend(() => {
    if (useSessionMemory) return Effect.succeed(sessionSnapshot);
    return primary.read.pipe(
      Effect.catch((error) =>
        Effect.sync(() => {
          useSessionMemory = true;
        }).pipe(Effect.andThen(Effect.fail(error))),
      ),
    );
  });

  const replace = Effect.fn("AccountProductMirror.runtimeFallbackReplace")(function* (
    snapshot: AccountProductSnapshot,
  ) {
    if (useSessionMemory) {
      sessionSnapshot = snapshot;
      return;
    }
    yield* primary.replace(snapshot).pipe(
      Effect.catch((error) =>
        Effect.sync(() => {
          sessionSnapshot = snapshot;
          useSessionMemory = true;
        }).pipe(Effect.andThen(Effect.fail(error))),
      ),
    );
  });

  const purge = Effect.suspend(() => {
    sessionSnapshot = null;
    return primary.purge.pipe(
      Effect.catch((error) =>
        Effect.sync(() => {
          useSessionMemory = true;
        }).pipe(Effect.andThen(Effect.fail(error))),
      ),
    );
  });

  return AccountProductMirror.of({
    changes: primary.changes,
    purge,
    read,
    readPerformance: () => (useSessionMemory ? "degraded" : primary.readPerformance()),
    replace,
    synchronize: (operation) =>
      Effect.suspend(() => (useSessionMemory ? operation : primary.synchronize(operation))).pipe(
        Effect.catch((error) =>
          Effect.sync(() => {
            useSessionMemory = true;
          }).pipe(Effect.andThen(Effect.fail(error))),
        ),
      ),
  });
};

export const makeSessionMemoryAccountProductMirrorLayer = (options?: {
  readonly initial?: AccountProductSnapshot | null;
  readonly readPerformance?: LocalReadPerformance;
}): Layer.Layer<AccountProductMirror> =>
  Layer.sync(AccountProductMirror, () => {
    let snapshot = options?.initial ?? null;

    return AccountProductMirror.of({
      changes: Stream.never,
      purge: Effect.sync(() => {
        snapshot = null;
      }),
      read: Effect.sync(() => snapshot),
      readPerformance: () => options?.readPerformance ?? "degraded",
      replace: (next) =>
        Effect.sync(() => {
          snapshot = next;
        }),
      synchronize: (operation) => operation,
    });
  });
