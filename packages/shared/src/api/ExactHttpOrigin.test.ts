import { describe, expect, it } from "vite-plus/test";

import { parseExactHttpOrigin } from "./ExactHttpOrigin.ts";

describe("exact HTTP origin", () => {
  it("normalizes exact HTTP(S) origins", () => {
    expect(parseExactHttpOrigin("https://app.plakk.io")).toBe("https://app.plakk.io");
    expect(parseExactHttpOrigin("http://localhost:3000/")).toBe("http://localhost:3000");
  });

  it("rejects credentials, paths, queries, fragments, and other protocols", () => {
    for (const value of [
      "https://user@app.plakk.io",
      "https://app.plakk.io/path",
      "https://app.plakk.io?query=true",
      "https://app.plakk.io#fragment",
      "plakk-app://renderer",
      "not a URL",
    ]) {
      expect(parseExactHttpOrigin(value)).toBeNull();
    }
  });
});
