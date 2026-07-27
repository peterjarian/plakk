import { describe, expect, it } from "vite-plus/test";

import { parseOtlpHeaders, validatedTelemetryEndpoint } from "./TelemetryConfig.ts";

describe("trusted telemetry configuration", () => {
  it("parses only the server-owned OTLP header collection", () => {
    expect(
      parseOtlpHeaders("Authorization=Bearer server-secret,X-Axiom-Dataset=plakk-production"),
    ).toEqual({
      Authorization: "Bearer server-secret",
      "X-Axiom-Dataset": "plakk-production",
    });
  });

  it("rejects malformed headers and credential-bearing/insecure production endpoints safely", () => {
    expect(() => parseOtlpHeaders("Authorization")).toThrow("OTEL exporter headers are invalid.");
    expect(() =>
      validatedTelemetryEndpoint("http://user:secret@api.axiom.co/v1/traces", true),
    ).toThrow("OTEL exporter endpoint must be a credential-free HTTPS URL.");
  });
});
