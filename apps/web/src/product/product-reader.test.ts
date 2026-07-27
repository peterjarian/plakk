import type { AccountStatus } from "@plakk/shared/PlakkApi";
import * as Effect from "effect/Effect";
import { describe, expect, it, vi } from "vite-plus/test";

import {
  MissingAccessToken,
  readAuthenticatedProduct,
  resolveProductRpcUrl,
} from "./product-reader.ts";

const account: AccountStatus = {
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
    };

    await expect(
      Effect.runPromise(readAuthenticatedProduct(rpc, async () => undefined)),
    ).rejects.toThrow(MissingAccessToken);
    expect(rpc.GetAccountStatus).not.toHaveBeenCalled();
    expect(rpc.GetSnippetSnapshot).not.toHaveBeenCalled();
  });

  it("resolves the independent product API from an exact configured origin", () => {
    expect(resolveProductRpcUrl("https://api.plakk.io")).toBe("https://api.plakk.io/api/rpc");
    expect(resolveProductRpcUrl(undefined)).toBe("http://localhost:3100/api/rpc");
    expect(() => resolveProductRpcUrl("https://api.plakk.io/path")).toThrow(
      "VITE_PLAKK_API_ORIGIN must be an exact HTTP(S) origin.",
    );
  });
});
