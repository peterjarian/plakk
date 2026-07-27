import * as Data from "effect/Data";

import { configuredWebOrigin as validateConfiguredWebOrigin } from "./WebOrigin.ts";

export class InvalidCorsConfiguration extends Data.TaggedError("InvalidCorsConfiguration")<{
  readonly cause: unknown;
  readonly message: string;
}> {}

export const BACKEND_CORS_ALLOWED_HEADERS = [
  "authorization",
  "content-type",
  "traceparent",
  "tracestate",
] as const;

export const allowedBackendOrigins = (
  configuredWebOrigin: string | undefined,
  requireHttps = false,
): ReadonlyArray<string> => {
  if (configuredWebOrigin === undefined) {
    if (requireHttps) {
      throw new InvalidCorsConfiguration({
        cause: "missing-production-web-origin",
        message: "PLAKK_WEB_ORIGIN is required in production.",
      });
    }
    return ["plakk-app://renderer"];
  }
  try {
    return ["plakk-app://renderer", validateConfiguredWebOrigin(configuredWebOrigin, requireHttps)];
  } catch {
    throw new InvalidCorsConfiguration({
      cause: "redacted-invalid-web-origin",
      message: "PLAKK_WEB_ORIGIN must be an exact HTTP(S) origin.",
    });
  }
};
