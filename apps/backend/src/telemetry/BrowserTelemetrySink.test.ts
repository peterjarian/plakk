import { describe, expect, it } from "vite-plus/test";

import { browserSpanToOtlp } from "./BrowserTelemetrySink.ts";

describe("browser span OTLP encoding", () => {
  it("uses trusted resource identity and preserves the propagated correlation IDs", () => {
    const payload = browserSpanToOtlp(
      {
        durationMillis: 25,
        errorKind: "FORBIDDEN",
        name: "snippet.delete",
        spanId: "0123456789abcdef",
        startedAtUnixMillis: 1_000,
        status: "ERROR",
        traceId: "0123456789abcdef0123456789abcdef",
      },
      { environment: "production", release: "d216771c" },
    );

    expect(payload).toMatchObject({
      resourceSpans: [
        {
          resource: {
            attributes: expect.arrayContaining([
              { key: "service.name", value: { stringValue: "plakk-web" } },
              { key: "service.version", value: { stringValue: "d216771c" } },
              {
                key: "deployment.environment.name",
                value: { stringValue: "production" },
              },
            ]),
          },
          scopeSpans: [
            {
              spans: [
                {
                  endTimeUnixNano: "1025000000",
                  name: "snippet.delete",
                  spanId: "0123456789abcdef",
                  startTimeUnixNano: "1000000000",
                  status: { code: "STATUS_CODE_ERROR" },
                  traceId: "0123456789abcdef0123456789abcdef",
                },
              ],
            },
          ],
        },
      ],
    });
    expect(JSON.stringify(payload)).not.toContain("FORBIDDEN");
    expect(JSON.stringify(payload)).not.toContain("credential");
  });
});
