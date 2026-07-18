import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Scope from "effect/Scope";
import { TestClock } from "effect/testing";

import { makeUploadExpirationLayer } from "./ServerRuntime.ts";
import { SnippetUploads } from "./SnippetUploads.ts";

const unexpectedUploadOperation = Effect.fn("ServerRuntimeTest.unexpectedUploadOperation")(() =>
  Effect.die("Unexpected upload operation in expiration runtime test."),
);

const buildExpirationRuntime = (expire: Effect.Effect<number>) => {
  const uploads = Layer.succeed(
    SnippetUploads,
    SnippetUploads.of({
      create: unexpectedUploadOperation,
      prepare: unexpectedUploadOperation,
      heartbeat: unexpectedUploadOperation,
      fail: unexpectedUploadOperation,
      retry: unexpectedUploadOperation,
      complete: unexpectedUploadOperation,
      expire,
    }),
  );
  return makeUploadExpirationLayer("30 seconds").pipe(Layer.provide(uploads));
};

describe("persistent backend responsibilities", () => {
  it.effect("sweeps immediately, repeats while alive, and stops with its scope", () =>
    Effect.gen(function* () {
      let sweeps = 0;
      const runtime = buildExpirationRuntime(
        Effect.sync(() => {
          sweeps += 1;
          return 0;
        }),
      );
      const scope = yield* Scope.make();

      yield* Layer.buildWithScope(runtime, scope);
      expect(sweeps).toBe(1);

      yield* TestClock.adjust("30 seconds");
      expect(sweeps).toBe(2);

      yield* Scope.close(scope, Exit.void);
      yield* TestClock.adjust("30 seconds");
      expect(sweeps).toBe(2);
    }),
  );

  it.effect("rechecks durable state after the runtime is recreated", () =>
    Effect.gen(function* () {
      const results: Array<number> = [];
      let stillExpired = true;
      const runtime = buildExpirationRuntime(
        Effect.sync(() => {
          const changed = stillExpired ? 1 : 0;
          stillExpired = false;
          results.push(changed);
          return changed;
        }),
      );

      const firstScope = yield* Scope.make();
      yield* Layer.buildWithScope(runtime, firstScope);
      yield* Scope.close(firstScope, Exit.void);

      const restartedScope = yield* Scope.make();
      yield* Layer.buildWithScope(runtime, restartedScope);
      yield* Scope.close(restartedScope, Exit.void);

      expect(results).toEqual([1, 0]);
    }),
  );
});
