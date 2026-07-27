import type { AccountStatus, ApiSnippet } from "@plakk/shared/PlakkApi";
import { describe, expect, it, vi } from "vite-plus/test";

import {
  clearProductThenSignOut,
  createAccountProductLifetime,
} from "./account-product-lifetime.ts";

const account: AccountStatus = {
  canSync: true,
  storageProvider: "GOOGLE_DRIVE",
  blockedReasons: [],
};

const snippet = (id: string): ApiSnippet => ({
  id,
  fileName: `${id}.png`,
  byteSize: 128,
  storageProvider: "GOOGLE_DRIVE",
  storageObjectId: `object-${id}`,
  createdAt: "2026-07-27T00:00:00.000Z",
  updatedAt: "2026-07-27T00:00:00.000Z",
});

const deferred = <A>() => {
  let resolve!: (value: A) => void;
  let reject!: (cause: unknown) => void;
  const promise = new Promise<A>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, reject, resolve };
};

const settle = () => Promise.resolve();

describe("account product lifetime", () => {
  it("loads one authoritative account snapshot for the active identity", async () => {
    const read = vi.fn().mockResolvedValue({ account, snippets: [snippet(crypto.randomUUID())] });
    const lifetime = createAccountProductLifetime({ read });

    lifetime.enter("user_1");
    expect(lifetime.getSnapshot()).toEqual({ accountId: "user_1", kind: "loading" });

    await settle();

    expect(read).toHaveBeenCalledOnce();
    expect(lifetime.getSnapshot()).toMatchObject({
      accountId: "user_1",
      account,
      kind: "ready",
    });
  });

  it("fences a late result from the previous account", async () => {
    const first = deferred<{ account: AccountStatus; snippets: ReadonlyArray<ApiSnippet> }>();
    const second = deferred<{ account: AccountStatus; snippets: ReadonlyArray<ApiSnippet> }>();
    const firstSnippet = snippet(crypto.randomUUID());
    const secondSnippet = snippet(crypto.randomUUID());
    const read = vi
      .fn()
      .mockImplementationOnce(() => first.promise)
      .mockImplementationOnce(() => second.promise);
    const lifetime = createAccountProductLifetime({ read });

    lifetime.enter("user_1");
    lifetime.enter("user_2");
    second.resolve({ account, snippets: [secondSnippet] });
    await settle();
    first.resolve({ account, snippets: [firstSnippet] });
    await settle();

    expect(lifetime.getSnapshot()).toEqual({
      account,
      accountId: "user_2",
      kind: "ready",
      snippets: [secondSnippet],
    });
  });

  it("revokes active work and clears every prior account fact before sign-out", async () => {
    const pending = deferred<{ account: AccountStatus; snippets: ReadonlyArray<ApiSnippet> }>();
    let signal: AbortSignal | undefined;
    const lifetime = createAccountProductLifetime({
      read: (_accountId, requestSignal) => {
        signal = requestSignal;
        return pending.promise;
      },
    });

    lifetime.enter("user_1");
    await lifetime.clear();

    expect(signal?.aborted).toBe(true);
    expect(lifetime.getSnapshot()).toEqual({ kind: "idle" });
  });

  it("exposes an honest retryable failure for the current account", async () => {
    const read = vi
      .fn()
      .mockRejectedValueOnce(new Error("backend unavailable"))
      .mockResolvedValueOnce({ account, snippets: [] });
    const lifetime = createAccountProductLifetime({ read });

    lifetime.enter("user_1");
    await settle();
    expect(lifetime.getSnapshot()).toEqual({
      accountId: "user_1",
      kind: "failed",
      message: "Plakk couldn’t load your snippets.",
    });

    lifetime.retry();
    await settle();
    expect(lifetime.getSnapshot()).toEqual({
      account,
      accountId: "user_1",
      kind: "ready",
      snippets: [],
    });
  });

  it("cleans product data before credential sign-out and fails closed", async () => {
    const order: Array<string> = [];
    await clearProductThenSignOut(
      async () => {
        order.push("clear");
      },
      async () => {
        order.push("sign-out");
      },
    );
    expect(order).toEqual(["clear", "sign-out"]);

    const signOut = vi.fn();
    await expect(
      clearProductThenSignOut(async () => Promise.reject(new Error("purge failed")), signOut),
    ).rejects.toThrow("purge failed");
    expect(signOut).not.toHaveBeenCalled();
  });
});
