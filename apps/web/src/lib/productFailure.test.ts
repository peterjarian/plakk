import { describe, expect, it } from "vite-plus/test";

import { productFailureFrom } from "./productFailure.ts";

const fallback = {
  title: "Couldn’t add this snippet",
  description: "Nothing was added. Try again.",
};

describe("web product failure presentation", () => {
  it("maps known runtime failures to actionable product copy", () => {
    expect(productFailureFrom({ _tag: "OfflineError", message: "fetch failed" }, fallback)).toEqual(
      {
        title: "Can’t reach Plakk",
        description: "Check your connection and try again.",
      },
    );

    expect(
      productFailureFrom({ _tag: "LocalStorageError", message: "SQLITE_IOERR" }, fallback),
    ).toEqual({
      title: "Browser storage is unavailable",
      description: "Reload this tab. Your snippets in connected storage are still safe.",
    });
  });

  it("never projects unknown JavaScript error text into the product UI", () => {
    const failure = productFailureFrom(
      new Error("TypeError: Cannot read properties of undefined"),
      fallback,
    );

    expect(failure).toEqual(fallback);
    expect(JSON.stringify(failure)).not.toContain("Cannot read properties");
  });
});
