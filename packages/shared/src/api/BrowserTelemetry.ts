import * as Schema from "effect/Schema";

export const BROWSER_TELEMETRY_SCHEMA_VERSION = 1 as const;

export const BrowserTelemetryOperationSchema = Schema.Literals([
  "account.refresh",
  "billing.checkout",
  "billing.portal",
  "snippet.delete",
  "snippet.prepare-download",
  "snippet.prepare-upload",
  "snippet.publish",
  "snippet.read-content",
  "storage.begin-cleanup",
  "storage.begin-link",
  "storage.management",
  "storage.retry-cleanup",
  "storage.status",
] as const);

export type BrowserTelemetryOperation = typeof BrowserTelemetryOperationSchema.Type;

export const BrowserTelemetryErrorKindSchema = Schema.Literals([
  "CONFLICT",
  "FORBIDDEN",
  "INTERNAL_SERVER_ERROR",
  "NOT_FOUND",
  "TRANSPORT",
  "UNAUTHENTICATED",
  "UNKNOWN",
] as const);

export type BrowserTelemetryErrorKind = typeof BrowserTelemetryErrorKindSchema.Type;

const TraceIdSchema = Schema.String.check(Schema.isPattern(/^[0-9a-f]{32}$/));
const SpanIdSchema = Schema.String.check(Schema.isPattern(/^[0-9a-f]{16}$/));

export const BrowserTelemetrySpanSchema = Schema.Struct({
  durationMillis: Schema.Finite.check(
    Schema.isInt(),
    Schema.isBetween({ minimum: 0, maximum: 120_000 }),
  ),
  errorKind: Schema.NullOr(BrowserTelemetryErrorKindSchema),
  name: BrowserTelemetryOperationSchema,
  spanId: SpanIdSchema,
  startedAtUnixMillis: Schema.Finite.check(
    Schema.isInt(),
    Schema.isBetween({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER }),
  ),
  status: Schema.Literals(["ERROR", "OK"] as const),
  traceId: TraceIdSchema,
});

export type BrowserTelemetrySpan = typeof BrowserTelemetrySpanSchema.Type;

export const BrowserTelemetryExportSchema = Schema.Struct({
  schemaVersion: Schema.Literal(BROWSER_TELEMETRY_SCHEMA_VERSION),
  span: BrowserTelemetrySpanSchema,
});

export type BrowserTelemetryExport = typeof BrowserTelemetryExportSchema.Type;
