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
import { BillingClient } from "./billing-client.ts";
import { StorageOnboardingClient } from "./storage-onboarding-client.ts";
import { WebSnippetActionRemote } from "./snippet-actions.ts";
import { WebSnippetUploadRemote } from "./snippet-upload.ts";
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

const storageOnboardingLayer = Layer.succeed(
  StorageOnboardingClient,
  StorageOnboardingClient.of({
    begin: () => Effect.succeed({ url: "https://api.workos.com/provider-redirect" }),
    read: () => Effect.succeed({ account, providerStatus: null }),
  }),
);
const productClientLayer = (
  id: string,
  overrides: {
    readonly delete?: WebSnippetActionRemote["Service"]["delete"];
    readonly read?: AccountProductReader["Service"]["read"];
  } = {},
) =>
  Layer.mergeAll(
    Layer.succeed(
      AccountProductReader,
      AccountProductReader.of({
        invalidations: Effect.void.pipe(Stream.fromEffect, Stream.concat(Stream.never)),
        read: overrides.read ?? Effect.succeed({ account, snippets: [snippet(id)] }),
      }),
    ),
    Layer.succeed(
      BillingClient,
      BillingClient.of({
        beginCheckout: () => Effect.succeed({ url: "https://checkout.example" }),
        openPortal: Effect.succeed({ url: "https://portal.example" }),
      }),
    ),
    storageOnboardingLayer,
    Layer.succeed(
      WebSnippetActionRemote,
      WebSnippetActionRemote.of({
        delete:
          overrides.delete ??
          (() => Effect.die("Snippet deletion is not used in this identity test.")),
        prepareDownload: () => Effect.die("Prepared downloads are not used in this identity test."),
        read: () => Effect.die("Snippet content is not used in this identity test."),
      }),
    ),
    Layer.succeed(
      WebSnippetUploadRemote,
      WebSnippetUploadRemote.of({
        prepare: () => Effect.die("Snippet upload is not used in this identity test."),
        publish: () => Effect.die("Snippet upload is not used in this identity test."),
      }),
    ),
  );

function ProductProbe() {
  const { signOut, snippetActions, state } = useWebProduct();
  const [signOutFailed, setSignOutFailed] = useState(false);
  return (
    <>
      <output>
        {state.kind === "ready"
          ? `${state.accountId}:${
              state.snippets[0] === undefined
                ? "empty"
                : state.snippets[0].kind === "PUBLISHED"
                  ? state.snippets[0].snippet.fileName
                  : state.snippets[0]?.fileName
            }`
          : `${state.kind}:${state.kind === "loading" ? state.accountId : "none"}`}
      </output>
      <span data-sign-out-result>{signOutFailed ? "failed" : "not-attempted"}</span>
      <button type="button" onClick={() => void signOut?.().catch(() => setSignOutFailed(true))}>
        Sign out
      </button>
      <button
        type="button"
        data-delete-snippet
        onClick={() => {
          if (state.kind !== "ready" || state.snippets[0]?.kind !== "PUBLISHED") return;
          void snippetActions?.delete(state.snippets[0].snippet.id);
        }}
      >
        Delete snippet
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
          productClientLayer={productClientLayer(accountId)}
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
          productClientLayer={productClientLayer("user_a")}
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

  it("refreshes the authoritative snapshot after Delete completes", async () => {
    const container = document.createElement("div");
    const root = createRoot(container);
    let deleted = false;
    const deleteRemote = vi.fn(() =>
      Effect.sync(() => {
        deleted = true;
      }),
    );
    const read = Effect.sync(() => ({
      account,
      snippets: deleted ? [] : [snippet("user_a")],
    }));
    mountedRoots.push(root);

    await act(async () => {
      root.render(
        <ProductIdentityBoundary
          accountId="user_a"
          delegateSignOut={vi.fn().mockResolvedValue(undefined)}
          productClientLayer={productClientLayer("user_a", {
            delete: deleteRemote,
            read,
          })}
        >
          <ProductProbe />
        </ProductIdentityBoundary>,
      );
    });
    expect(container.querySelector("output")?.textContent).toBe("user_a:user_a.png");

    await act(async () => {
      container.querySelector<HTMLButtonElement>("[data-delete-snippet]")?.click();
    });

    expect(deleteRemote).toHaveBeenCalledWith("user_a");
    expect(container.querySelector("output")?.textContent).toBe("user_a:empty");
  });
});
