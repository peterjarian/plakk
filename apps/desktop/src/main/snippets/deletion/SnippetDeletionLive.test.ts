import type { ApiSnippet } from "@plakk/shared/PlakkApi";
import { RpcError } from "@plakk/shared/RpcError";
import { describe, expect, it, vi } from "vite-plus/test";
import { Effect, Layer, Stream } from "effect";

import { PlakkRpcClient } from "../../PlakkRpcClient.ts";
import {
  ManagedSnippetContent,
  ManagedSnippetContentError,
} from "../content/ManagedSnippetContent.ts";
import { SnippetReplica, type SnippetReplicaState } from "../replica/SnippetReplica.ts";
import { SnippetDeletion, SnippetDeletionLive } from "./SnippetDeletion.ts";

const account = { id: "user-1", accessToken: "token" } as const;
const published: ApiSnippet = {
  id: "0d1e2f3a-4567-4890-8abc-def012345678",
  fileName: "published.txt",
  byteSize: 12,
  storageProvider: "GOOGLE_DRIVE",
  storageObjectId: "drive-id",
  createdAt: "2026-07-20T20:00:00.000Z",
  updatedAt: "2026-07-20T20:00:01.000Z",
};

const harness = (options: { remoteFailure?: RpcError; contentFailure?: boolean } = {}) => {
  let state: SnippetReplicaState = {
    items: [{ kind: "PUBLISHED", snippet: published }],
  };
  const events: Array<string> = [];
  const remoteDelete = vi.fn(() => {
    expect(state.items).toHaveLength(1);
    events.push("remote-delete");
    return options.remoteFailure === undefined ? Effect.void : Effect.fail(options.remoteFailure);
  });
  const discard = vi.fn(() => {
    events.push("content-discard");
    return options.contentFailure === true
      ? Effect.fail(
          new ManagedSnippetContentError({
            cause: null,
            reason: "simulated cleanup failure",
            retryable: true,
          }),
        )
      : Effect.void;
  });
  const layer = SnippetDeletionLive.pipe(
    Layer.provide(
      Layer.mergeAll(
        Layer.succeed(PlakkRpcClient, PlakkRpcClient.of({ DeleteSnippet: remoteDelete } as never)),
        Layer.succeed(
          SnippetReplica,
          SnippetReplica.of({
            changes: Stream.empty,
            get: (accountId) => Effect.succeed(accountId === account.id ? state : { items: [] }),
            commit: (_accountId, next) => Effect.sync(() => void (state = next)),
            update: (_accountId, transform) =>
              Effect.sync(() => {
                state = transform(state);
                return state;
              }),
            remove: (_accountId, snippetId) =>
              Effect.sync(() => {
                events.push("replica-remove");
                state = {
                  items: state.items.filter(
                    (record) =>
                      (record.kind === "LOCAL" ? record.id : record.snippet.id) !== snippetId,
                  ),
                };
              }),
            purge: () => Effect.void,
          }),
        ),
        Layer.succeed(ManagedSnippetContent, ManagedSnippetContent.of({ discard } as never)),
      ),
    ),
  );
  return { discard, events, layer, remoteDelete, state: () => state };
};

describe("Electron-main completed Snippet deletion", () => {
  it("keeps the shared collection unchanged until confirmation, then removes content", async () => {
    const test = harness();

    await Effect.runPromise(
      SnippetDeletion.use((deletion) => deletion.delete(account, published.id)).pipe(
        Effect.provide(test.layer),
      ),
    );

    expect(test.events).toEqual(["remote-delete", "replica-remove", "content-discard"]);
    expect(test.state()).toEqual({ items: [] });
    expect(test.remoteDelete).toHaveBeenCalledWith(
      { id: published.id },
      { headers: { authorization: `Bearer ${account.accessToken}` } },
    );
    expect(test.discard).toHaveBeenCalledWith(account.id, published.id);
  });

  it("leaves the shared collection and managed content unchanged on command failure", async () => {
    const test = harness({
      remoteFailure: new RpcError({ code: "INTERNAL_SERVER_ERROR", message: "offline" }),
    });

    await expect(
      Effect.runPromise(
        SnippetDeletion.use((deletion) => deletion.delete(account, published.id)).pipe(
          Effect.provide(test.layer),
        ),
      ),
    ).rejects.toMatchObject({ code: "INTERNAL_SERVER_ERROR" });

    expect(test.state().items).toHaveLength(1);
    expect(test.discard).not.toHaveBeenCalled();
  });

  it("cannot delete a published record belonging to another local account", async () => {
    const test = harness();

    await Effect.runPromise(
      SnippetDeletion.use((deletion) =>
        deletion.delete({ id: "user-2", accessToken: "other-token" }, published.id),
      ).pipe(Effect.provide(test.layer)),
    );

    expect(test.state().items).toHaveLength(1);
    expect(test.remoteDelete).not.toHaveBeenCalled();
    expect(test.discard).not.toHaveBeenCalled();
  });

  it("surfaces content cleanup failure without restoring the shared record", async () => {
    const test = harness({ contentFailure: true });

    await expect(
      Effect.runPromise(
        SnippetDeletion.use((deletion) => deletion.delete(account, published.id)).pipe(
          Effect.provide(test.layer),
        ),
      ),
    ).rejects.toMatchObject({ _tag: "ManagedSnippetContentError" });

    expect(test.state()).toEqual({ items: [] });
    expect(test.discard).toHaveBeenCalledOnce();
  });
});
