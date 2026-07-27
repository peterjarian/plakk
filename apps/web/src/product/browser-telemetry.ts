import {
  BROWSER_TELEMETRY_SCHEMA_VERSION,
  type BrowserTelemetryErrorKind,
  type BrowserTelemetryExport,
  type BrowserTelemetryOperation,
} from "@plakk/shared/BrowserTelemetry";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";

export type ObservedRpcOptions = {
  readonly headers: Readonly<Record<string, string>>;
};

type BrowserTelemetryExporter = (
  body: BrowserTelemetryExport,
  authorization: string,
) => Promise<void>;

export interface BrowserTelemetry {
  readonly observeRpc: <A, E, R>(
    operation: BrowserTelemetryOperation,
    options: ObservedRpcOptions,
    invoke: (options: ObservedRpcOptions) => Effect.Effect<A, E, R>,
  ) => Effect.Effect<A, E, R>;
}

export const observeBrowserRpc = <A, E, R>(
  telemetry: BrowserTelemetry | undefined,
  operation: BrowserTelemetryOperation,
  options: ObservedRpcOptions,
  invoke: (options: ObservedRpcOptions) => Effect.Effect<A, E, R>,
): Effect.Effect<A, E, R> =>
  telemetry === undefined ? invoke(options) : telemetry.observeRpc(operation, options, invoke);

const defaultRandomBytes = (length: number): Uint8Array => {
  const bytes = new Uint8Array(length);
  globalThis.crypto.getRandomValues(bytes);
  if (bytes.every((byte) => byte === 0)) bytes[length - 1] = 1;
  return bytes;
};

const hex = (bytes: Uint8Array): string =>
  Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");

const allowedRpcErrorCodes = new Set<BrowserTelemetryErrorKind>([
  "CONFLICT",
  "FORBIDDEN",
  "INTERNAL_SERVER_ERROR",
  "NOT_FOUND",
  "UNAUTHENTICATED",
]);

const safeErrorKind = (cause: Cause.Cause<unknown>): BrowserTelemetryErrorKind => {
  const failure = Cause.squash(cause);
  if (typeof failure === "object" && failure !== null) {
    const code = "code" in failure ? failure.code : undefined;
    if (typeof code === "string" && allowedRpcErrorCodes.has(code as BrowserTelemetryErrorKind)) {
      return code as BrowserTelemetryErrorKind;
    }
    const tag = "_tag" in failure ? failure._tag : undefined;
    if (tag === "RpcClientError" || tag === "AccessTokenFailure") return "TRANSPORT";
    if (tag === "MissingAccessToken") return "UNAUTHENTICATED";
  }
  return "UNKNOWN";
};

export const makeBrowserTelemetry = (options: {
  readonly exporter: BrowserTelemetryExporter;
  readonly now?: () => number;
  readonly randomBytes?: (length: number) => Uint8Array;
}): BrowserTelemetry => {
  const now = options.now ?? Date.now;
  const randomBytes = options.randomBytes ?? defaultRandomBytes;

  return {
    observeRpc: (operation, requestOptions, invoke) => {
      const startedAtUnixMillis = Math.round(now());
      const traceId = hex(randomBytes(16));
      const spanId = hex(randomBytes(8));
      const tracedOptions = {
        headers: {
          ...requestOptions.headers,
          traceparent: `00-${traceId}-${spanId}-01`,
        },
      } satisfies ObservedRpcOptions;

      return invoke(tracedOptions).pipe(
        Effect.onExit((exit) =>
          Effect.sync(() => {
            const failed = Exit.isFailure(exit);
            const body: BrowserTelemetryExport = {
              schemaVersion: BROWSER_TELEMETRY_SCHEMA_VERSION,
              span: {
                durationMillis: Math.min(
                  120_000,
                  Math.max(0, Math.round(now()) - startedAtUnixMillis),
                ),
                errorKind: failed ? safeErrorKind(exit.cause) : null,
                name: operation,
                spanId,
                startedAtUnixMillis,
                status: failed ? "ERROR" : "OK",
                traceId,
              },
            };
            const authorization = requestOptions.headers.authorization;
            if (authorization === undefined) return;
            try {
              void options.exporter(body, authorization).catch(() => undefined);
            } catch {
              // Observability is deliberately non-interfering.
            }
          }),
        ),
      );
    },
  };
};

export const makeBrowserTelemetryExporter =
  (
    proxyUrl: string,
    fetchImplementation: typeof globalThis.fetch = globalThis.fetch,
  ): BrowserTelemetryExporter =>
  async (body, authorization) => {
    const response = await fetchImplementation(proxyUrl, {
      body: JSON.stringify(body),
      cache: "no-store",
      credentials: "omit",
      headers: {
        authorization,
        "content-type": "application/json",
      },
      keepalive: true,
      method: "POST",
      referrerPolicy: "no-referrer",
    });
    if (!response.ok) throw new Error("Browser telemetry export was rejected.");
  };
