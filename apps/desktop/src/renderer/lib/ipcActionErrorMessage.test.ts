import { describe, expect, it } from "vite-plus/test";

import { ipcActionErrorMessage } from "./ipcActionErrorMessage.ts";

describe("IPC action error presentation", () => {
  it("preserves the actionable message sanitized by Electron main", () => {
    expect(
      ipcActionErrorMessage(
        new Error("There isn’t enough space on this Mac to save this file."),
        "Could not download this snippet.",
      ),
    ).toBe("There isn’t enough space on this Mac to save this file.");
  });

  it("uses the surface fallback for unknown rejection values", () => {
    expect(ipcActionErrorMessage(null, "Could not download this snippet.")).toBe(
      "Could not download this snippet.",
    );
  });
});
