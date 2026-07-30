// @vitest-environment happy-dom

import type { ClientSnapshot, Snippet } from "@plakk/client-runtime";
import { Effect, Stream } from "effect";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import type { RunClient } from "../runtime/client.ts";
import { REMOTE_THUMBNAIL_RETRY_DELAY_MS, useSnippets } from "./useSnippets.ts";

const image: Snippet = {
  id: "8c72d6f6-9a25-4633-b72f-d8f83cf1c8e0",
  fileName: "photo.png",
  byteSize: 3,
  storageProvider: "GOOGLE_DRIVE",
  mediaType: "image/png",
  storageObjectId: "object-1",
  status: "PUBLISHED",
  errorMessage: null,
  createdAt: "2026-07-11T00:00:00.000Z",
  updatedAt: "2026-07-11T00:00:00.000Z",
  localContentAvailability: { status: "NOT_AVAILABLE" },
};

const snapshot: ClientSnapshot = {
  user: {
    id: "user-1",
    firstName: "Test",
    lastName: "User",
    email: "test@example.com",
    createdAt: "2026-07-20T18:00:00.000Z",
    updatedAt: "2026-07-20T18:00:00.000Z",
  },
  capability: {
    status: "OFFLINE",
    storageProvider: { known: false, value: null },
  },
  syncStatus: "CONNECTED",
  storageUsageBytes: 0,
  snippets: [image],
};

const roots: Array<ReturnType<typeof createRoot>> = [];
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:thumbnail");
  vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => undefined);
});

afterEach(async () => {
  for (const root of roots.splice(0)) {
    await act(async () => root.unmount());
  }
  document.body.replaceChildren();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("remote thumbnail loading", () => {
  it("retries a transient failure after a bounded cooldown", async () => {
    let attempts = 0;
    const client = {
      content: {
        readRemote: () => {
          attempts += 1;
          return attempts === 1
            ? Stream.fail(new Error("Temporarily offline."))
            : Stream.make(Uint8Array.from([1, 2, 3]));
        },
      },
    };
    const run: RunClient = (operation) =>
      Effect.runPromise(operation(client as never) as Effect.Effect<unknown>) as Promise<never>;
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    roots.push(root);

    function Harness() {
      const { items } = useSnippets({ loading: false, snapshot, run });
      return <div data-thumbnail={items[0]?.thumbnailUrl ?? ""} />;
    }

    await act(async () => root.render(<Harness />));
    expect(attempts).toBe(1);
    expect(container.firstElementChild?.getAttribute("data-thumbnail")).toBe("");

    await act(async () => {
      await vi.advanceTimersByTimeAsync(REMOTE_THUMBNAIL_RETRY_DELAY_MS);
    });

    expect(attempts).toBe(2);
    expect(container.firstElementChild?.getAttribute("data-thumbnail")).toBe("blob:thumbnail");
  });
});
