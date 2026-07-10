import { describe, expect, it } from "vite-plus/test";
import { isUnauthenticatedAccountError } from "./accountStatus.ts";

describe("account status errors", () => {
  it("distinguishes invalid sessions from transient account failures", () => {
    expect(isUnauthenticatedAccountError({ code: "UNAUTHENTICATED" })).toBe(true);
    expect(isUnauthenticatedAccountError({ code: "INTERNAL_SERVER_ERROR" })).toBe(false);
    expect(isUnauthenticatedAccountError(new Error("offline"))).toBe(false);
  });
});
