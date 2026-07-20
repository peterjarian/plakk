import type { ApiSnippet } from "@plakk/shared/PlakkApi";
import { RpcError } from "@plakk/shared/RpcError";
import { describe, expect, it, vi } from "vite-plus/test";
import { Effect, Layer, Stream } from "effect";

import type { ResolvedSnippetIngestPayload } from "../../../ipc/contracts.ts";
import { ManagedSnippetContent } from "../content/ManagedSnippetContent.ts";
import { SnippetReplica, type SnippetReplicaState } from "../replica/SnippetReplica.ts";
import { SnippetUploadEngine } from "./SnippetUploadEngine.ts";
import { SnippetUploadEngineLive } from "./SnippetUploadEngineLive.ts";
import { SnippetUploadRemote } from "./SnippetUploadRemote.ts";
import { StorageUpload } from "./StorageUpload.ts";

const account = { id: "user-1", accessToken: "token" } as const;
const input: ResolvedSnippetIngestPayload = {
  id: "0d1e2f3a-4567-4890-8abc-def012345678",
  fileName: "note.txt",
  byteSize: 4,
  mediaType: "text/plain",
  storageProvider: "GOOGLE_DRIVE",
  bytes: new Uint8Array([110, 111, 116, 101]),
};
const published: ApiSnippet = {
  id: input.id,
  fileName: input.fileName,
  byteSize: input.byteSize,
  storageProvider: input.storageProvider,
  storageObjectId: "drive-object",
  createdAt: "2026-07-20T20:00:00.000Z",
  updatedAt: "2026-07-20T20:00:00.000Z",
};

const waitUntil = async (predicate: () => boolean) => {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error("Timed out waiting for upload state.");
};

const harness = (
  options: {
    initial?: SnippetReplicaState;
    prepareFailure?: RpcError;
    publishGate?: Promise<void>;
  } = {},
) => {
  let state: SnippetReplicaState = options.initial ?? { items: [] };
  const discard = vi.fn(() => Effect.void);
  const prepare = vi.fn(() =>
    options.prepareFailure === undefined
      ? Effect.succeed({
          storageProvider: "GOOGLE_DRIVE" as const,
          storageObjectId: null,
          upload: {
            method: "PUT" as const,
            url: "https://upload.example",
            headers: [],
            strategy: { type: "single_request" as const },
          },
          expiresAt: null,
        })
      : Effect.fail(options.prepareFailure),
  );
  const publish = vi.fn(() =>
    Effect.promise(async () => {
      await options.publishGate;
      return published;
    }),
  );
  const layer = SnippetUploadEngineLive.pipe(
    Layer.provide(
      Layer.mergeAll(
        Layer.succeed(
          SnippetReplica,
          SnippetReplica.of({
            changes: Stream.empty,
            get: () => Effect.succeed(state),
            commit: (_accountId, next) => Effect.sync(() => void (state = next)),
            update: (_accountId, transform) =>
              Effect.sync(() => {
                state = transform(state);
                return state;
              }),
            remove: (_accountId, snippetId) =>
              Effect.sync(() => {
                state = {
                  items: state.items.filter((record) =>
                    record.kind === "LOCAL"
                      ? record.id !== snippetId
                      : record.snippet.id !== snippetId,
                  ),
                };
              }),
            purge: () => Effect.sync(() => void (state = { items: [] })),
          }),
        ),
        Layer.succeed(
          ManagedSnippetContent,
          ManagedSnippetContent.of({
            ingest: () => Effect.void,
            path: () => Effect.succeed("/managed/note.txt"),
            discard,
          } as never),
        ),
        Layer.succeed(
          SnippetUploadRemote,
          SnippetUploadRemote.of({
            prepare,
            publish,
          }),
        ),
        Layer.succeed(
          StorageUpload,
          StorageUpload.of({
            upload: () => Effect.succeed({ storageObjectId: published.storageObjectId }),
          }),
        ),
      ),
    ),
  );
  return { discard, layer, prepare, publish, state: () => state };
};

describe("SnippetUploadEngine", () => {
  it("persists one local uploading record before remote work and promotes it after publication", async () => {
    const test = harness();
    test.prepare.mockImplementationOnce(() => {
      expect(test.state().items).toMatchObject([
        { kind: "LOCAL", id: input.id, status: "UPLOADING" },
      ]);
      return Effect.succeed({
        storageProvider: "GOOGLE_DRIVE",
        storageObjectId: null,
        upload: {
          method: "PUT",
          url: "https://upload.example",
          headers: [],
          strategy: { type: "single_request" },
        },
        expiresAt: null,
      });
    });

    await Effect.runPromise(
      SnippetUploadEngine.use((engine) => engine.ingest(account, input)).pipe(
        Effect.provide(test.layer),
      ),
    );
    await waitUntil(() => test.state().items[0]?.kind === "PUBLISHED");

    expect(test.prepare).toHaveBeenCalledTimes(1);
    expect(test.publish).toHaveBeenCalledWith(account.accessToken, {
      id: input.id,
      fileName: input.fileName,
      byteSize: input.byteSize,
      storageProvider: input.storageProvider,
      storageObjectId: published.storageObjectId,
    });
    expect(test.state()).toEqual({ items: [{ kind: "PUBLISHED", snippet: published }] });
  });

  it("keeps Electron-main work running after the initiating command returns", async () => {
    let releasePublication: (() => void) | undefined;
    const publicationGate = new Promise<void>((resolve) => {
      releasePublication = resolve;
    });
    const test = harness({ publishGate: publicationGate });

    await Effect.runPromise(
      SnippetUploadEngine.use((engine) => engine.ingest(account, input)).pipe(
        Effect.provide(test.layer),
      ),
    );
    await waitUntil(() => test.publish.mock.calls.length === 1);
    expect(test.state().items[0]).toMatchObject({ kind: "LOCAL", status: "UPLOADING" });

    releasePublication?.();
    await waitUntil(() => test.state().items[0]?.kind === "PUBLISHED");
  });

  it("turns command failure into one dismissible local record and never retries", async () => {
    const test = harness({
      prepareFailure: new RpcError({ code: "INTERNAL_SERVER_ERROR", message: "offline" }),
    });

    await Effect.runPromise(
      SnippetUploadEngine.use((engine) => engine.ingest(account, input)).pipe(
        Effect.provide(test.layer),
      ),
    );
    await waitUntil(() => {
      const record = test.state().items[0];
      return record?.kind === "LOCAL" && record.status === "FAILED";
    });

    expect(test.prepare).toHaveBeenCalledTimes(1);
    expect(test.publish).not.toHaveBeenCalled();
    expect(test.state().items[0]).toMatchObject({
      kind: "LOCAL",
      status: "FAILED",
      errorMessage: "offline",
    });
  });

  it("dismisses failed local records and their temporary managed bytes", async () => {
    const failed = {
      kind: "LOCAL" as const,
      id: input.id,
      fileName: input.fileName,
      byteSize: input.byteSize,
      storageProvider: input.storageProvider,
      status: "FAILED" as const,
      errorMessage: "Upload failed.",
      createdAt: "2026-07-20T20:00:00.000Z",
      updatedAt: "2026-07-20T20:00:01.000Z",
    };
    const test = harness({ initial: { items: [failed] } });

    await Effect.runPromise(
      SnippetUploadEngine.use((engine) => engine.discard(account.id, input.id)).pipe(
        Effect.provide(test.layer),
      ),
    );

    expect(test.state()).toEqual({ items: [] });
    expect(test.discard).toHaveBeenCalledWith(account.id, input.id);
  });

  it("normalizes persisted uploading records to failed without starting remote work", async () => {
    const uploading = {
      kind: "LOCAL" as const,
      id: input.id,
      fileName: input.fileName,
      byteSize: input.byteSize,
      storageProvider: input.storageProvider,
      status: "UPLOADING" as const,
      errorMessage: null,
      createdAt: "2026-07-20T20:00:00.000Z",
      updatedAt: "2026-07-20T20:00:00.000Z",
    };
    const test = harness({ initial: { items: [uploading] } });

    await Effect.runPromise(
      SnippetUploadEngine.use((engine) => engine.normalize(account.id)).pipe(
        Effect.provide(test.layer),
      ),
    );

    expect(test.state().items[0]).toMatchObject({ kind: "LOCAL", status: "FAILED" });
    expect(test.prepare).not.toHaveBeenCalled();
    expect(test.publish).not.toHaveBeenCalled();
  });
});
