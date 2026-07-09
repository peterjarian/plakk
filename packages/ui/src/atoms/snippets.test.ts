import { describe, expect, it } from "vite-plus/test";
import { AtomRegistry } from "effect/unstable/reactivity";

import { uploadTasksAtom } from "./upload.ts";
import { removeSnippet, snippetsAtom, upsertSnippet, visibleSnippetsAtom } from "./snippets.ts";

const text = {
  id: "text-1",
  title: "Note",
  subtitle: "4 characters",
  kind: "TEXT",
  time: "now",
  synced: false,
} as const;

const upload = {
  id: "file-1",
  fileName: "paper.pdf",
  byteSize: 2048,
  contentType: "application/pdf",
  kind: "FILE",
  storageProvider: "GOOGLE_DRIVE",
  phase: "UPLOADING",
  progress: 25,
  storageObjectId: null,
  errorMessage: null,
} as const;

describe("snippet atoms", () => {
  it("keeps snippet updates by id", () => {
    const updated = { ...text, title: "Updated" };

    expect(upsertSnippet([], text)).toEqual([text]);
    expect(upsertSnippet([text], updated)).toEqual([updated]);
    expect(removeSnippet([text], text.id)).toEqual([]);
  });

  it("shows upload rows before persisted snippets", () => {
    const registry = AtomRegistry.make();

    registry.set(snippetsAtom, [text, { ...text, id: upload.id }]);
    registry.set(uploadTasksAtom, [upload]);

    expect(registry.get(visibleSnippetsAtom)).toEqual([
      {
        id: upload.id,
        title: upload.fileName,
        subtitle: "PDF · 2.0 KB",
        kind: upload.kind,
        time: "",
        synced: false,
        uploadProgress: upload.progress,
      },
      text,
    ]);
  });
});
