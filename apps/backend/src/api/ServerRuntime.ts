import { Drizzle, PgClientLive } from "@plakk/db";
import type * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { FetchHttpClient } from "effect/unstable/http";

import { StorageProviderService } from "./storage/StorageProvider.ts";
import { SnippetUploads } from "./SnippetUploads.ts";

const InfrastructureLive = Layer.mergeAll(
  Drizzle.Live,
  PgClientLive,
  StorageProviderService.Live,
).pipe(Layer.provideMerge(FetchHttpClient.layer));

const BackendServicesLive = SnippetUploads.Live.pipe(Layer.provideMerge(InfrastructureLive));

export const makeUploadExpirationLayer = (
  interval: Duration.Input,
): Layer.Layer<never, never, SnippetUploads> =>
  Layer.effectDiscard(
    Effect.gen(function* () {
      const uploads = yield* SnippetUploads;
      const sweep = uploads.expire.pipe(
        Effect.tap((expired) =>
          expired === 0
            ? Effect.void
            : Effect.logInfo("Expired abandoned snippet uploads", { expired }),
        ),
      );

      yield* sweep;
      yield* Effect.gen(function* () {
        while (true) {
          yield* Effect.sleep(interval);
          yield* sweep.pipe(
            Effect.catchCause((cause) =>
              Effect.logError("Snippet upload expiration sweep failed", { cause }),
            ),
          );
        }
      }).pipe(
        Effect.onInterrupt(() => Effect.logInfo("Snippet upload expiration stopped")),
        Effect.forkScoped,
      );
    }),
  );

const UploadExpirationLive = makeUploadExpirationLayer("30 seconds").pipe(
  Layer.provide(BackendServicesLive),
);

export const ServerRuntimeLive = Layer.mergeAll(BackendServicesLive, UploadExpirationLive);
