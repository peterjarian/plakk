import { describe, expect, it } from "vite-plus/test";

import { allowedBackendOrigins } from "./cors.ts";

describe("backend CORS origins", () => {
  it("retains Desktop and adds one exact configured Web origin", () => {
    expect(allowedBackendOrigins("https://app.plakk.io")).toEqual([
      "plakk-app://renderer",
      "https://app.plakk.io",
    ]);
    expect(allowedBackendOrigins("http://localhost:3000")).toEqual([
      "plakk-app://renderer",
      "http://localhost:3000",
    ]);
  });

  it("rejects paths, credentials, and non-HTTP Web origins", () => {
    for (const value of [
      "https://app.plakk.io/path",
      "https://user@app.plakk.io",
      "plakk-app://renderer",
    ]) {
      expect(() => allowedBackendOrigins(value)).toThrow(
        "PLAKK_WEB_ORIGIN must be an exact HTTP(S) origin.",
      );
    }
  });
});
