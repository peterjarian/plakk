import * as Clock from "effect/Clock";
import * as Config from "effect/Config";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Result from "effect/Result";
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/unstable/http";

import { WorkosAccessTokenVerifier } from "../middleware/WorkosAccessTokenVerifier.ts";
import { BrowserTelemetryRateLimiter } from "./BrowserTelemetryRateLimiter.ts";
import { ingestBrowserTelemetry } from "./BrowserTelemetryProxy.ts";
import { BrowserTelemetrySink } from "./BrowserTelemetrySink.ts";

const MAX_BROWSER_TELEMETRY_BYTES = 16_384;

export const handleBrowserTelemetryRequest = (expectedOrigin: string) =>
  Effect.gen(function* () {
    const request = yield* HttpServerRequest.HttpServerRequest;
    const limiter = yield* BrowserTelemetryRateLimiter;
    const sink = yield* BrowserTelemetrySink;
    const verifier = yield* WorkosAccessTokenVerifier;
    const now = yield* Clock.currentTimeMillis;
    const bodyResult = yield* request.text.pipe(
      Effect.provideService(
        HttpServerRequest.MaxBodySize,
        FileSystem.Size(MAX_BROWSER_TELEMETRY_BYTES),
      ),
      Effect.result,
    );
    if (Result.isFailure(bodyResult)) {
      return HttpServerResponse.empty({ status: 413 });
    }

    return yield* ingestBrowserTelemetry(
      {
        authorization: request.headers.authorization,
        body: bodyResult.success,
        contentType: request.headers["content-type"],
        expectedOrigin,
        origin: request.headers.origin,
      },
      {
        allow: limiter.allow,
        exportSpan: sink.exportSpan,
        now: () => now,
        verifyAccessToken: verifier.verify,
      },
    ).pipe(
      Effect.match({
        onFailure: (rejection) => HttpServerResponse.empty({ status: rejection.status }),
        onSuccess: () => HttpServerResponse.empty({ status: 204 }),
      }),
    );
  });

export const BrowserTelemetryRoute = Layer.unwrap(
  Config.nonEmptyString("PLAKK_WEB_ORIGIN").pipe(
    Effect.map((expectedOrigin) =>
      HttpRouter.add(
        "POST",
        "/api/telemetry/v1/traces",
        handleBrowserTelemetryRequest(expectedOrigin),
      ).pipe(HttpRouter.serve),
    ),
  ),
);
