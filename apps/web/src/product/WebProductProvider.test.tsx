// @vitest-environment happy-dom

import type { AccountStatus, ApiSnippet } from "@plakk/shared/PlakkApi";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import { act, StrictMode, useState } from "react";
import { createRoot } from "react-dom/client";
import { flushSync } from "react-dom";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import { AccountProductReader } from "./product-reader.ts";
import { StorageOnboardingClient } from "./storage-onboarding-client.ts";
import { ProductIdentityBoundary, useWebProduct } from "./WebProductProvider.tsx";

const account: AccountStatus = {
  accessEntitlement: {
    status: "TRIAL_ACTIVE",
    trialEndsAt: DateTime.makeUnsafe("2026-08-10T00:00:00.000Z"),
  },
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

const readerLayer = (id: string) =>
  Layer.succeed(
    AccountProductReader,
    AccountProductReader.of({
      invalidations: Effect.void.pipe(Stream.fromEffect, Stream.concat(Stream.never)),
      read: Effect.succeed({ account, snippets: [snippet(id)] }),
    }),
  );
const storageOnboardingLayer = Layer.succeed(
  StorageOnboardingClient,
  StorageOnboardingClient.of({
    begin: () => Effect.succeed({ url: "https://api.workos.com/provider-redirect" }),
    read: () => Effect.succeed({ account, providerStatus: null }),
  }),
);

function ProductProbe() {
  const { signOut, state } = useWebProduct();
  const [signOutFailed, setSignOutFailed] = useState(false);
  return (
    <>
      <output>
        {state.kind === "ready"
          ? `${state.accountId}:${state.snippets[0]?.fileName}`
          : `${state.kind}:${state.kind === "loading" ? state.accountId : "none"}`}
      </output>
      <span data-sign-out-result>{signOutFailed ? "failed" : "not-attempted"}</span>
      <button type="button" onClick={() => void signOut?.().catch(() => setSignOutFailed(true))}>
        Sign out
      </button>
    </>
  );
}

const mountedRoots: Array<ReturnType<typeof createRoot>> = [];

afterEach(async () => {
  await act(async () => {
    for (const root of mountedRoots.splice(0)) root.unmount();
  });
});

describe("Web product identity boundary", () => {
  it("replaces the account resource before the next identity can render", async () => {
    const container = document.createElement("div");
    const root = createRoot(container);
    const delegateSignOut = vi.fn().mockResolvedValue(undefined);
    mountedRoots.push(root);

    const renderIdentity = (accountId: string) => (
      <StrictMode>
        <ProductIdentityBoundary
          accountId={accountId}
          delegateSignOut={delegateSignOut}
          readerLayer={readerLayer(accountId)}
          storageOnboardingLayer={storageOnboardingLayer}
        >
          <ProductProbe />
        </ProductIdentityBoundary>
      </StrictMode>
    );

    await act(async () => {
      root.render(renderIdentity("user_a"));
    });
    expect(container.querySelector("output")?.textContent).toBe("user_a:user_a.png");

    flushSync(() => {
      root.render(renderIdentity("user_b"));
    });
    expect(container.querySelector("output")?.textContent).not.toContain("user_a");
    expect(container.querySelector("output")?.textContent).toBe("loading:user_b");

    await act(async () => undefined);
    expect(container.querySelector("output")?.textContent).toBe("user_b:user_b.png");

    await act(async () => {
      container.querySelector("button")?.click();
    });
    expect(delegateSignOut).toHaveBeenCalledOnce();
    expect(container.querySelector("output")?.textContent).toBe("idle:none");
  });

  it("reloads the current account when delegated sign-out fails", async () => {
    const container = document.createElement("div");
    const root = createRoot(container);
    const delegateSignOut = vi.fn().mockRejectedValue(new Error("WorkOS unavailable"));
    mountedRoots.push(root);

    await act(async () => {
      root.render(
        <ProductIdentityBoundary
          accountId="user_a"
          delegateSignOut={delegateSignOut}
          readerLayer={readerLayer("user_a")}
          storageOnboardingLayer={storageOnboardingLayer}
        >
          <ProductProbe />
        </ProductIdentityBoundary>,
      );
    });
    expect(container.querySelector("output")?.textContent).toBe("user_a:user_a.png");

    await act(async () => {
      container.querySelector("button")?.click();
    });

    expect(delegateSignOut).toHaveBeenCalledOnce();
    expect(container.querySelector("[data-sign-out-result]")?.textContent).toBe("failed");
    expect(container.querySelector("output")?.textContent).toBe("user_a:user_a.png");
  });
});
