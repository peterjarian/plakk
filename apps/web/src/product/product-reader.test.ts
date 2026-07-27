import {
  SNIPPET_INVALIDATION_KEEP_ALIVE,
  SNIPPETS_CHANGED,
  type AccountStatus,
} from "@plakk/shared/PlakkApi";
import { RpcError } from "@plakk/shared/RpcError";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";
import { describe, expect, it, vi } from "vite-plus/test";

import {
  MissingAccessToken,
  readAuthenticatedProduct,
  resolveProductRpcUrl,
  watchAuthenticatedInvalidations,
} from "./product-reader.ts";

const account: AccountStatus = {
  accessEntitlement: {
    status: "TRIAL_ACTIVE",
    trialStartedAt: "2026-07-27T00:00:00.000Z",
    trialEndsAt: "2026-08-10T00:00:00.000Z",
  },
  canSync: true,
  storageProvider: "DROPBOX",
  blockedReasons: [],
};

describe("authenticated product reader", () => {
  it("uses one freshly retrieved bearer token for account and snapshot RPCs", async () => {
    const headers: Array<Readonly<Record<string, string>>> = [];
    const getAccessToken = vi.fn().mockResolvedValue("fresh-token");
    const rpc = {
      GetAccountStatus: (_payload: undefined, options: { headers: Record<string, string> }) => {
        headers.push(options.headers);
        return Effect.succeed(account);
      },
      GetSnippetSnapshot: (_payload: undefined, options: { headers: Record<string, string> }) => {
        headers.push(options.headers);
        return Effect.succeed([]);
      },
      WatchSnippetInvalidations: () => Stream.empty,
    };

    await expect(Effect.runPromise(readAuthenticatedProduct(rpc, getAccessToken))).resolves.toEqual(
      { account, snippets: [] },
    );
    expect(getAccessToken).toHaveBeenCalledOnce();
    expect(headers).toEqual([
      { authorization: "Bearer fresh-token" },
      { authorization: "Bearer fresh-token" },
    ]);
  });

  it("fails as unauthenticated when AuthKit cannot provide a token", async () => {
    const rpc = {
      GetAccountStatus: vi.fn(),
      GetSnippetSnapshot: vi.fn(),
      WatchSnippetInvalidations: vi.fn(),
    };

    await expect(
      Effect.runPromise(readAuthenticatedProduct(rpc, async () => undefined)),
    ).rejects.toThrow(MissingAccessToken);
    expect(rpc.GetAccountStatus).not.toHaveBeenCalled();
    expect(rpc.GetSnippetSnapshot).not.toHaveBeenCalled();
  });

  it("uses a fresh bearer token for each stream connection and ignores keep-alives", async () => {
    const headers: Array<Readonly<Record<string, string>>> = [];
    const getAccessToken = vi
      .fn<() => Promise<string>>()
      .mockResolvedValueOnce("stream-token-1")
      .mockResolvedValueOnce("stream-token-2");
    const rpc = {
      GetAccountStatus: vi.fn(),
      GetSnippetSnapshot: vi.fn(),
      WatchSnippetInvalidations: (
        _payload: undefined,
        options: { headers: Record<string, string> },
      ) => {
        headers.push(options.headers);
        return Stream.make(SNIPPET_INVALIDATION_KEEP_ALIVE, SNIPPETS_CHANGED);
      },
    };

    const invalidations = watchAuthenticatedInvalidations(rpc, getAccessToken);
    await expect(
      Effect.runPromise(
        Stream.concat(invalidations, invalidations).pipe(Stream.runCollect, Effect.map(Array.from)),
      ),
    ).resolves.toEqual([undefined, undefined]);
    expect(getAccessToken).toHaveBeenCalledTimes(2);
    expect(headers).toEqual([
      { authorization: "Bearer stream-token-1" },
      { authorization: "Bearer stream-token-2" },
    ]);
  });

  it("surfaces a missing stream token instead of completing silently", async () => {
    const rpc = {
      GetAccountStatus: vi.fn(),
      GetSnippetSnapshot: vi.fn(),
      WatchSnippetInvalidations: vi.fn(),
    };

    await expect(
      Effect.runPromise(
        watchAuthenticatedInvalidations(rpc, async () => undefined).pipe(Stream.runCollect),
      ),
    ).rejects.toThrow(MissingAccessToken);
    expect(rpc.WatchSnippetInvalidations).not.toHaveBeenCalled();
  });

  it("surfaces an RPC stream failure instead of completing silently", async () => {
    const failure = new RpcError({
      code: "INTERNAL_SERVER_ERROR",
      message: "stream unavailable",
    });
    const rpc = {
      GetAccountStatus: vi.fn(),
      GetSnippetSnapshot: vi.fn(),
      WatchSnippetInvalidations: vi.fn(() => Stream.fail(failure)),
    };

    await expect(
      Effect.runPromise(
        watchAuthenticatedInvalidations(rpc, async () => "fresh-token").pipe(Stream.runCollect),
      ),
    ).rejects.toBe(failure);
  });

  it("resolves the independent product API from an exact configured origin", () => {
    expect(resolveProductRpcUrl("https://api.plakk.io")).toBe("https://api.plakk.io/api/rpc");
    expect(resolveProductRpcUrl(undefined, true)).toBe("http://localhost:3100/api/rpc");
    expect(resolveProductRpcUrl("http://localhost:3100", true)).toBe(
      "http://localhost:3100/api/rpc",
    );
    expect(() => resolveProductRpcUrl("https://api.plakk.io/path")).toThrow(
      "VITE_PLAKK_API_ORIGIN must be an exact HTTP(S) origin.",
    );
  });

  it("fails closed when production API configuration is missing or insecure", () => {
    expect(() => resolveProductRpcUrl(undefined)).toThrow(
      "VITE_PLAKK_API_ORIGIN is required outside local development.",
    );
    expect(() => resolveProductRpcUrl("http://api.plakk.io")).toThrow(
      "VITE_PLAKK_API_ORIGIN must use HTTPS outside local development.",
    );
  });
});
