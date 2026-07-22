import { describe, expect, it } from "@effect/vitest";
import { Effect, Layer, Stream } from "effect";

import { LocalState } from "../local-state/LocalState.ts";
import {
  ManagedSnippetContent,
  ManagedSnippetContentError,
} from "../snippets/content/ManagedSnippetContent.ts";
import { SnippetHydrationEngine } from "../snippets/hydration/SnippetHydration.ts";
import { SnippetReplica } from "../snippets/replica/SnippetReplica.ts";
import { SnippetUploadEngine } from "../snippets/upload/SnippetUploadEngine.ts";
import { DesktopAccountData } from "./DesktopAccountData.ts";
import { DesktopAccountDataLive } from "./DesktopAccountDataLive.ts";

describe("desktop account purge", () => {
  it.effect(
    "attempts every account-owned cleanup and retains the account owner after a failure",
    () =>
      Effect.gen(function* () {
        const calls: Array<string> = [];
        const record = (owner: string) => Effect.sync(() => void calls.push(owner));
        const layers = Layer.mergeAll(
          Layer.succeed(
            SnippetReplica,
            SnippetReplica.of({
              changes: Stream.empty,
              commit: () => Effect.void,
              get: () => Effect.succeed(null),
              update: (_accountId, transform) => Effect.succeed(transform({ items: [] })),
              purge: () => record("replica"),
              remove: () => Effect.void,
            }),
          ),
          Layer.succeed(
            SnippetUploadEngine,
            SnippetUploadEngine.of({
              discard: () => Effect.void,
              ingest: () => Effect.void,
              pause: Effect.void,
              purge: () => record("uploads"),
              normalize: () => Effect.void,
            }),
          ),
          Layer.succeed(
            SnippetHydrationEngine,
            SnippetHydrationEngine.of({
              changes: Stream.empty,
              download: () => Effect.void,
              freeUpSpace: () => Effect.void,
              pause: Effect.void,
              purge: () => record("hydration"),
              reconcile: () => Effect.succeed(new Map()),
              resume: () => Effect.void,
              state: () => Effect.succeed({ status: "NOT_AVAILABLE" }),
            }),
          ),
          Layer.succeed(
            ManagedSnippetContent,
            ManagedSnippetContent.of({
              available: () => Effect.succeed(false),
              changes: Stream.empty,
              discard: () => Effect.void,
              get: () => Effect.succeed(null),
              getPrefix: () => Effect.succeed(null),
              ingest: () => Effect.succeed("/managed/content"),
              invalidate: () => Effect.void,
              path: () => Effect.succeed("/managed/content"),
              purge: () =>
                record("content").pipe(
                  Effect.andThen(
                    Effect.fail(
                      new ManagedSnippetContentError({
                        cause: null,
                        reason: "simulated failure",
                        retryable: true,
                      }),
                    ),
                  ),
                ),
              putStream: () => Effect.void,
              removeExcept: () => Effect.void,
              storageUsageBytes: () => Effect.succeed(0),
              validateText: () => Effect.succeed("NOT_FOUND"),
            }),
          ),
          Layer.succeed(
            LocalState,
            LocalState.of({
              changes: Stream.empty,
              current: Effect.die("unused"),
              owner: Effect.die("unused"),
              refresh: Effect.void,
              update: (update) => record(`local-state:${update.kind}`),
            }),
          ),
        );

        const result = yield* DesktopAccountData.use((data) => data.purge("user_1")).pipe(
          Effect.provide(DesktopAccountDataLive.pipe(Layer.provide(layers))),
          Effect.result,
        );

        expect(result).toMatchObject({
          _tag: "Failure",
          failure: { _tag: "DesktopAccountPurgeError" },
        });

        expect(calls).toEqual(
          expect.arrayContaining(["uploads", "hydration", "replica", "content"]),
        );
        expect(calls).not.toContain("local-state:signed-out");
      }),
  );
});
