import type { ApiSnippet } from "@plakk/shared/PlakkApi";
import { SnippetHydrationTransport } from "./Services/SnippetHydration.ts";
import { RpcError } from "@plakk/shared/RpcError";
import { Effect, Fiber, Layer, Stream } from "effect";
import { describe, expect, it, vi } from "vite-plus/test";

import { PlakkRpcClient } from "./PlakkRpcClient.ts";
import { snippetHydrationTransportLayer } from "./Layers/SnippetHydrationTransport.ts";

const snippet: ApiSnippet = {
  id: "0d1e2f3a-4567-4890-8abc-def012345678",
  byteSize: 4,
  fileName: "note.txt",
  storageObjectId: "object-1",
  storageProvider: "GOOGLE_DRIVE",
  uploadStatus: "UPLOADED",
  createdAt: "2026-07-16T09:00:00.000Z",
  updatedAt: "2026-07-16T09:00:00.000Z",
};

const account = { id: "user-1", accessToken: "workos-token" };

const collect = (client: object, fetch: typeof globalThis.fetch) =>
  Effect.gen(function* () {
    const transport = yield* SnippetHydrationTransport;
    return yield* Stream.runCollect(transport.stream(account, snippet));
  }).pipe(
    Effect.provide(
      snippetHydrationTransportLayer(fetch).pipe(
        Layer.provide(Layer.succeed(PlakkRpcClient, client as never)),
      ),
    ),
  );

describe("SnippetHydrationTransport", () => {
  it("streams a prepared provider download without buffering it", async () => {
    const prepare = vi.fn(() =>
      Effect.succeed({
        storageProvider: "GOOGLE_DRIVE" as const,
        fileName: snippet.fileName,
        byteSize: snippet.byteSize,
        download: {
          url: "https://www.googleapis.com/drive/v3/files/object-1?alt=media",
          headers: [{ name: "Authorization", value: "Bearer provider-token" }],
        },
      }),
    );
    const fetch = vi.fn(
      async () =>
        new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              controller.enqueue(new Uint8Array([1, 2]));
              controller.enqueue(new Uint8Array([3, 4]));
              controller.close();
            },
          }),
        ),
    );

    const chunks = await Effect.runPromise(collect({ PrepareSnippetDownload: prepare }, fetch));

    expect(prepare).toHaveBeenCalledWith(
      { id: snippet.id },
      { headers: { authorization: "Bearer workos-token" } },
    );
    expect(fetch).toHaveBeenCalledWith(
      "https://www.googleapis.com/drive/v3/files/object-1?alt=media",
      {
        headers: { Authorization: "Bearer provider-token" },
        signal: expect.any(AbortSignal),
      },
    );
    expect(Array.from(chunks).map((chunk) => Array.from(chunk))).toEqual([
      [1, 2],
      [3, 4],
    ]);
  });

  it("rejects a prepared URL outside the authoritative provider", async () => {
    const prepare = vi.fn(() =>
      Effect.succeed({
        storageProvider: "GOOGLE_DRIVE" as const,
        fileName: snippet.fileName,
        byteSize: snippet.byteSize,
        download: { url: "https://localhost/private", headers: [] },
      }),
    );
    const fetch = vi.fn();

    const exit = await Effect.runPromise(
      Effect.exit(collect({ PrepareSnippetDownload: prepare }, fetch as typeof globalThis.fetch)),
    );

    expect(exit._tag).toBe("Failure");
    expect(fetch).not.toHaveBeenCalled();
  });

  it("preserves an actionable preparation failure without retrying it as connectivity", async () => {
    const prepare = vi.fn(() =>
      Effect.fail(new RpcError({ code: "NOT_FOUND", message: "Uploaded snippet was not found." })),
    );

    const error = await Effect.runPromise(
      Effect.flip(collect({ PrepareSnippetDownload: prepare }, vi.fn())),
    );

    expect(error).toMatchObject({
      _tag: "SnippetHydrationError",
      reason: "This snippet is no longer available to download.",
      retryable: false,
    });
  });

  it("rejects download preparation for different snippet metadata", async () => {
    const prepare = vi.fn(() =>
      Effect.succeed({
        storageProvider: "GOOGLE_DRIVE" as const,
        fileName: snippet.fileName,
        byteSize: 5,
        download: {
          url: "https://www.googleapis.com/drive/v3/files/object-1?alt=media",
          headers: [],
        },
      }),
    );
    const fetch = vi.fn();

    const exit = await Effect.runPromise(
      Effect.exit(collect({ PrepareSnippetDownload: prepare }, fetch as typeof globalThis.fetch)),
    );

    expect(exit._tag).toBe("Failure");
    expect(fetch).not.toHaveBeenCalled();
  });

  it("aborts a pending provider request when hydration is cancelled", async () => {
    const prepare = vi.fn(() =>
      Effect.succeed({
        storageProvider: "GOOGLE_DRIVE" as const,
        fileName: snippet.fileName,
        byteSize: snippet.byteSize,
        download: {
          url: "https://www.googleapis.com/drive/v3/files/object-1?alt=media",
          headers: [],
        },
      }),
    );
    const providerSignals: Array<AbortSignal> = [];
    const fetch = vi.fn<typeof globalThis.fetch>(
      (_input, init) =>
        new Promise<Response>((_resolve, reject) => {
          const signal = init?.signal;
          if (signal != null) {
            providerSignals.push(signal);
            signal.addEventListener("abort", () => reject(signal.reason));
          }
        }),
    );

    const fiber = Effect.runFork(collect({ PrepareSnippetDownload: prepare }, fetch));
    await vi.waitFor(() => expect(providerSignals).toHaveLength(1));
    await Effect.runPromise(Fiber.interrupt(fiber));

    expect(providerSignals[0]?.aborted).toBe(true);
  });
});
