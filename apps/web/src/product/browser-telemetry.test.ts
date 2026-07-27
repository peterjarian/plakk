import { RpcError } from "@plakk/shared/RpcError";
import { describe, expect, it, vi } from "vite-plus/test";
import * as Effect from "effect/Effect";

import { makeBrowserTelemetry } from "./browser-telemetry.ts";
import {
  resolveBrowserTelemetryProxyUrl,
  resolveBrowserTelemetryRelease,
} from "./web-product-client-layer.ts";

const deterministicBytes = (length: number): Uint8Array =>
  Uint8Array.from({ length }, (_, index) => index + 1);

describe("browser action telemetry", () => {
  it("derives the authenticated proxy from the exact backend RPC endpoint", () => {
    expect(resolveBrowserTelemetryProxyUrl("https://api.plakk.io/api/rpc")).toBe(
      "https://api.plakk.io/api/telemetry/v1/traces",
    );
    expect(() => resolveBrowserTelemetryProxyUrl("https://api.plakk.io/other")).toThrow(
      "canonical /api/rpc",
    );
  });

  it("requires the bounded Web release outside local development", () => {
    expect(resolveBrowserTelemetryRelease("web-abc123", false)).toBe("web-abc123");
    expect(resolveBrowserTelemetryRelease(undefined, true)).toBe("development");
    expect(() => resolveBrowserTelemetryRelease(undefined, false)).toThrow("VITE_PLAKK_RELEASE");
    expect(() => resolveBrowserTelemetryRelease("release with spaces", false)).toThrow(
      "VITE_PLAKK_RELEASE",
    );
  });

  it("uses one standard trace context for the RPC and sanitized exported span", async () => {
    const exported: Array<{
      readonly authorization: string;
      readonly body: unknown;
    }> = [];
    const now = vi.fn().mockReturnValueOnce(1_000).mockReturnValueOnce(1_025);
    const telemetry = makeBrowserTelemetry({
      exporter: (body, authorization) => {
        exported.push({ authorization, body });
        return Promise.resolve();
      },
      now,
      randomBytes: deterministicBytes,
      release: "web-release-abc123",
    });
    let requestHeaders: Readonly<Record<string, string>> = {};
    const failure = new RpcError({
      code: "FORBIDDEN",
      message: "protected filename and clipboard content must stay local",
    });

    const result = await Effect.runPromise(
      telemetry
        .observeRpc(
          "snippet.delete",
          { headers: { authorization: "Bearer browser-access-token" } },
          (options) => {
            requestHeaders = options.headers;
            return Effect.fail(failure);
          },
        )
        .pipe(Effect.result),
    );

    expect(result).toMatchObject({ _tag: "Failure", failure });
    expect(requestHeaders).toMatchObject({
      authorization: "Bearer browser-access-token",
      traceparent: "00-0102030405060708090a0b0c0d0e0f10-0102030405060708-01",
    });
    expect(exported).toEqual([
      {
        authorization: "Bearer browser-access-token",
        body: {
          release: "web-release-abc123",
          schemaVersion: 1,
          span: {
            durationMillis: 25,
            errorKind: "FORBIDDEN",
            name: "snippet.delete",
            spanId: "0102030405060708",
            startedAtUnixMillis: 1_000,
            status: "ERROR",
            traceId: "0102030405060708090a0b0c0d0e0f10",
          },
        },
      },
    ]);
    expect(JSON.stringify(exported[0]?.body)).not.toContain(failure.message);
    expect(JSON.stringify(exported[0]?.body)).not.toContain("browser-access-token");
  });

  it("does not let exporter failure change successful product behavior", async () => {
    const telemetry = makeBrowserTelemetry({
      exporter: () => Promise.reject(new Error("Axiom unavailable")),
      now: () => 1_000,
      randomBytes: deterministicBytes,
      release: "web-release-abc123",
    });

    await expect(
      Effect.runPromise(
        telemetry.observeRpc(
          "account.refresh",
          { headers: { authorization: "Bearer token" } },
          () => Effect.succeed("product-result"),
        ),
      ),
    ).resolves.toBe("product-result");
  });
});
