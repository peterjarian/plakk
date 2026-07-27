import {
  BrowserTelemetryExportSchema,
  type BrowserTelemetrySpan,
} from "@plakk/shared/BrowserTelemetry";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

const MAX_BROWSER_TELEMETRY_BYTES = 16_384;
const MAX_CLOCK_SKEW_MILLIS = 300_000;

type ProxyRejectionCode =
  | "INVALID_ENVELOPE"
  | "ORIGIN_REJECTED"
  | "RATE_LIMITED"
  | "UNAUTHENTICATED"
  | "UNSUPPORTED_MEDIA_TYPE"
  | "UPSTREAM_UNAVAILABLE";

export class BrowserTelemetryProxyRejection extends Data.TaggedError(
  "BrowserTelemetryProxyRejection",
)<{
  readonly code: ProxyRejectionCode;
  readonly status: 400 | 401 | 403 | 413 | 415 | 429 | 502;
}> {}

export type BrowserTelemetryProxyRequest = {
  readonly authorization: string | undefined;
  readonly body: string;
  readonly contentType: string | undefined;
  readonly expectedOrigin: string;
  readonly origin: string | undefined;
};

export type BrowserTelemetryProxyDependencies = {
  readonly allow: (workosUserId: string) => Effect.Effect<boolean>;
  readonly exportSpan: (span: BrowserTelemetrySpan) => Effect.Effect<void, Error>;
  readonly now: () => number;
  readonly verifyAccessToken: (
    accessToken: string,
  ) => Effect.Effect<{ readonly id: string }, Error>;
};

const reject = (code: ProxyRejectionCode, status: BrowserTelemetryProxyRejection["status"]) =>
  new BrowserTelemetryProxyRejection({ code, status });

const hasExactKeys = (value: unknown, keys: ReadonlyArray<string>): boolean => {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const actual = Object.keys(value).toSorted();
  return actual.length === keys.length && actual.every((key, index) => key === keys[index]);
};

const isStrictEnvelope = (value: unknown): boolean => {
  if (!hasExactKeys(value, ["schemaVersion", "span"])) return false;
  const span = (value as { readonly span?: unknown }).span;
  return hasExactKeys(span, [
    "durationMillis",
    "errorKind",
    "name",
    "spanId",
    "startedAtUnixMillis",
    "status",
    "traceId",
  ]);
};

export const ingestBrowserTelemetry = Effect.fn("BrowserTelemetryProxy.ingest")(function* (
  request: BrowserTelemetryProxyRequest,
  dependencies: BrowserTelemetryProxyDependencies,
) {
  if (request.origin !== request.expectedOrigin) {
    return yield* reject("ORIGIN_REJECTED", 403);
  }
  if (!request.contentType?.toLowerCase().startsWith("application/json")) {
    return yield* reject("UNSUPPORTED_MEDIA_TYPE", 415);
  }
  if (new TextEncoder().encode(request.body).byteLength > MAX_BROWSER_TELEMETRY_BYTES) {
    return yield* reject("INVALID_ENVELOPE", 413);
  }

  const [scheme, accessToken] = request.authorization?.split(" ", 2) ?? [];
  if (scheme?.toLowerCase() !== "bearer" || accessToken === undefined || accessToken === "") {
    return yield* reject("UNAUTHENTICATED", 401);
  }
  const currentUser = yield* dependencies
    .verifyAccessToken(accessToken)
    .pipe(Effect.mapError(() => reject("UNAUTHENTICATED", 401)));
  if (!(yield* dependencies.allow(currentUser.id))) {
    return yield* reject("RATE_LIMITED", 429);
  }

  const parsed = yield* Schema.decodeUnknownEffect(Schema.UnknownFromJsonString)(request.body).pipe(
    Effect.mapError(() => reject("INVALID_ENVELOPE", 400)),
  );
  if (!isStrictEnvelope(parsed)) return yield* reject("INVALID_ENVELOPE", 400);

  const telemetry = yield* Schema.decodeUnknownEffect(BrowserTelemetryExportSchema)(parsed).pipe(
    Effect.mapError(() => reject("INVALID_ENVELOPE", 400)),
  );
  if (
    (telemetry.span.status === "OK" && telemetry.span.errorKind !== null) ||
    (telemetry.span.status === "ERROR" && telemetry.span.errorKind === null)
  ) {
    return yield* reject("INVALID_ENVELOPE", 400);
  }
  const age = dependencies.now() - telemetry.span.startedAtUnixMillis;
  if (age < -MAX_CLOCK_SKEW_MILLIS || age > MAX_CLOCK_SKEW_MILLIS) {
    return yield* reject("INVALID_ENVELOPE", 400);
  }

  yield* dependencies
    .exportSpan(telemetry.span)
    .pipe(Effect.mapError(() => reject("UPSTREAM_UNAVAILABLE", 502)));
});
