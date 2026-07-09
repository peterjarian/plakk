import { describe, expect, it } from "vite-plus/test";

import { nextUploadProgress } from "./uploadProgress.ts";

describe("upload progress", () => {
  it("advances without passing 100", () => {
    expect(nextUploadProgress({ progress: 12 })).toBe(20);
    expect(nextUploadProgress({ progress: 96 })).toBe(100);
  });
});
