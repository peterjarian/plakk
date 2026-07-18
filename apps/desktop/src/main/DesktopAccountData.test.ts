import { ManagedSnippetContentError, SnippetReplica } from "@plakk/shared/SnippetReplica";
import { SnippetHydrationEngine } from "@plakk/shared/SnippetHydration";
import { describe, expect, it } from "@effect/vitest";
import { Effect, Layer, Stream } from "effect";

import { DesktopAccountDataLive } from "./Layers/DesktopAccountData.ts";
import { DesktopManagedSnippetContent } from "./ManagedSnippetContent.ts";
import { DesktopAccountData } from "./Services/DesktopAccountData.ts";
import { LocalState } from "./Services/LocalState.ts";
import { SnippetUploadEngine } from "./SnippetUploadEngine.ts";
import { SnippetUploadOutbox } from "./SnippetUploadOutbox.ts";

describe("desktop account purge", () => {
  it.effect(
    "attempts every account-owned cleanup and clears local state even after a failure",
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
              purge: () => record("replica"),
              remove: () => Effect.void,
            }),
          ),
          Layer.succeed(
            SnippetUploadOutbox,
            SnippetUploadOutbox.of({
              get: () => Effect.succeed(null),
              list: () => Effect.succeed([]),
              purge: () => record("outbox"),
              put: () => Effect.void,
              remove: () => Effect.void,
            }),
          ),
          Layer.succeed(
            SnippetUploadEngine,
            SnippetUploadEngine.of({
              cancel: () => Effect.void,
              changes: Stream.empty,
              delete: () => Effect.void,
              discard: () => Effect.void,
              ingest: () => Effect.void,
              pause: Effect.void,
              project: () => Effect.succeed([]),
              purge: () => record("uploads"),
              reconcile: () => Effect.void,
              resume: () => Effect.void,
              retry: () => Effect.void,
            }),
          ),
          Layer.succeed(
            SnippetHydrationEngine,
            SnippetHydrationEngine.of({
              changes: Stream.empty,
              download: () => Effect.void,
              pause: Effect.void,
              purge: () => record("hydration"),
              reconcile: () => Effect.succeed(new Map()),
              resume: () => Effect.void,
              state: () => Effect.succeed({ status: "NOT_AVAILABLE" }),
              updateSettings: () => Effect.void,
            }),
          ),
          Layer.succeed(
            DesktopManagedSnippetContent,
            DesktopManagedSnippetContent.of({
              available: () => Effect.succeed(false),
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
              validateText: () => Effect.succeed("NOT_FOUND"),
            }),
          ),
          Layer.succeed(
            LocalState,
            LocalState.of({
              changes: Stream.empty,
              current: Effect.die("unused"),
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
          expect.arrayContaining([
            "uploads",
            "hydration",
            "replica",
            "outbox",
            "content",
            "local-state:signed-out",
          ]),
        );
      }),
  );
});
