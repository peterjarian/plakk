import { RpcError } from "@plakk/shared/RpcError";
import { describe, expect, it } from "vite-plus/test";
import * as Cause from "effect/Cause";
import * as Data from "effect/Data";
import * as Exit from "effect/Exit";

import { sanitizeTelemetryExit, telemetryErrorAttributes } from "./TelemetrySanitization.ts";

describe("backend telemetry sanitization", () => {
  it("retains only bounded error type/code attributes", () => {
    const cause = new RpcError({
      code: "FORBIDDEN",
      message:
        "snippet content, filename.txt, clipboard data, cookie, authorization code, signed URL",
    });

    expect(telemetryErrorAttributes(cause)).toEqual({
      errorCode: "FORBIDDEN",
      errorType: "RpcError",
    });
  });

  it("removes messages, stacks, causes, and raw provider bodies from exported span exits", () => {
    const protectedValue = "raw-provider-body-with-credential-and-cookie";
    class ProtectedFailure extends Data.TaggedError("ProtectedFailure")<{
      readonly cause: unknown;
      readonly message: string;
    }> {}
    const exit = Exit.failCause(
      Cause.fail(
        new ProtectedFailure({
          cause: { protectedValue },
          message: "safe message",
        }),
      ),
    );

    const sanitized = sanitizeTelemetryExit(exit);
    if (Exit.isSuccess(sanitized)) throw new Error("Expected a sanitized failure.");
    const serialized = Cause.pretty(sanitized.cause);
    expect(serialized).toContain("ProtectedFailure");
    expect(serialized).not.toContain("safe message");
    expect(serialized).not.toContain(protectedValue);
  });
});
