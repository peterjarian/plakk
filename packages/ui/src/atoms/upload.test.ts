import { describe, expect, it } from "vite-plus/test";
import { AtomRegistry } from "effect/unstable/reactivity";

import {
  activeUploadTasksAtom,
  makeUploadTask,
  removeUploadTask,
  updateUploadTask,
  uploadTasksAtom,
  upsertUploadTask,
} from "./upload.ts";

const draft = {
  id: "upload-1",
  fileName: "photo.png",
  byteSize: 4,
  contentType: "image/png",
  storageProvider: "GOOGLE_DRIVE",
} as const;

describe("upload atoms", () => {
  it("keeps upload task updates by id", () => {
    const first = makeUploadTask(draft);
    const second = { ...first, phase: "UPLOADING" as const, progress: 50 };

    expect(upsertUploadTask([], first)).toEqual([first]);
    expect(upsertUploadTask([first], second)).toEqual([second]);
    expect(updateUploadTask([first], first.id, (task) => ({ ...task, progress: 25 }))).toEqual([
      { ...first, progress: 25 },
    ]);
    expect(removeUploadTask([first], first.id)).toEqual([]);
  });

  it("derives active uploads from the registry", () => {
    const registry = AtomRegistry.make();
    const uploading = makeUploadTask(draft);
    const ready = makeUploadTask({ ...draft, id: "upload-2" });

    registry.set(uploadTasksAtom, [uploading, { ...ready, phase: "UPLOADED" }]);

    expect(registry.get(activeUploadTasksAtom)).toEqual([uploading]);
  });
});
