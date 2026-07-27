import { describe, expect, it } from "vite-plus/test";
import * as Schema from "effect/Schema";

import { BrowserTelemetryExportSchema, type BrowserTelemetryExport } from "./BrowserTelemetry.ts";

const validExport: BrowserTelemetryExport = {
  schemaVersion: 1,
  span: {
    durationMillis: 25,
    errorKind: null,
    name: "snippet.delete",
    spanId: "0123456789abcdef",
    startedAtUnixMillis: 1_785_161_520_000,
    status: "OK",
    traceId: "0123456789abcdef0123456789abcdef",
  },
};

describe("browser telemetry envelope", () => {
  it("accepts only bounded correlation and operation facts", () => {
    expect(Schema.decodeUnknownSync(BrowserTelemetryExportSchema)(validExport)).toEqual(
      validExport,
    );
  });

  it("rejects invalid trace context and unbounded durations", () => {
    for (const span of [
      { ...validExport.span, traceId: "not-a-trace-id" },
      { ...validExport.span, spanId: "0123" },
      { ...validExport.span, durationMillis: 120_001 },
    ]) {
      expect(() =>
        Schema.decodeUnknownSync(BrowserTelemetryExportSchema)({
          ...validExport,
          span,
        }),
      ).toThrow();
    }
  });
});
