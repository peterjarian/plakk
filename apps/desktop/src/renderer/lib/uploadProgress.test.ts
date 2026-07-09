import { describe, expect, it } from "vite-plus/test";

import { advanceUploadProgress, nextUploadProgress } from "./uploadProgress.ts";

describe("upload progress", () => {
  it("advances without passing 100", () => {
    expect(nextUploadProgress({ progress: 12 })).toBe(20);
    expect(nextUploadProgress({ progress: 96 })).toBe(100);
  });

  it("marks uploads ready when progress completes", () => {
    const progress: Array<[string, number]> = [];
    const phases: Array<[string, string]> = [];

    advanceUploadProgress({
      snapshot: () => [
        { id: "a", phase: "UPLOADING", progress: 92 },
        { id: "b", phase: "READY", progress: 100 },
      ],
      setProgress: (id, value) => progress.push([id, value]),
      setPhase: (id, phase) => phases.push([id, phase]),
    });

    expect(progress).toEqual([["a", 100]]);
    expect(phases).toEqual([["a", "READY"]]);
  });
});
