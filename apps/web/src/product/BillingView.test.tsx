// @vitest-environment happy-dom

import type { User } from "@plakk/shared";
import type { AccountStatus } from "@plakk/shared/PlakkApi";
import * as DateTime from "effect/DateTime";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import type { AccountProductState } from "./account-product-lifetime.ts";
import { BillingView } from "./BillingView.tsx";

const user: User = {
  id: "user-1",
  email: "person@example.com",
  firstName: "Person",
  lastName: "Example",
  createdAt: "2026-07-01T00:00:00.000Z",
  updatedAt: "2026-07-01T00:00:00.000Z",
};

const readyState = (account: AccountStatus): AccountProductState => ({
  account,
  accountId: user.id,
  apiAvailability: "available",
  kind: "ready",
  liveConnection: "connected",
  localReadPerformance: "accelerated",
  snippets: [],
});

const account = (
  accessEntitlement: AccountStatus["accessEntitlement"],
  blockedReasons: AccountStatus["blockedReasons"] = [],
): AccountStatus => ({
  accessEntitlement,
  blockedReasons,
  canSync: blockedReasons.length === 0,
  storageProvider: "GOOGLE_DRIVE",
});

const billing = {
  beginCheckout: vi.fn(() => Promise.resolve({ url: "https://checkout.example" })),
  openPortal: vi.fn(() => Promise.resolve({ url: "https://portal.example" })),
};

const render = (
  state: AccountProductState,
  overrides: Partial<Parameters<typeof BillingView>[0]> = {},
) =>
  renderToStaticMarkup(
    <BillingView
      billing={billing}
      checkoutReturned={false}
      onBack={() => undefined}
      onNavigate={() => undefined}
      onSettings={() => undefined}
      onSignOut={() => undefined}
      refresh={null}
      state={state}
      user={user}
      {...overrides}
    />,
  );

const mountedRoots: Array<ReturnType<typeof createRoot>> = [];

afterEach(async () => {
  vi.useRealTimers();
  billing.beginCheckout.mockClear();
  billing.openPortal.mockClear();
  await act(async () => {
    for (const root of mountedRoots.splice(0)) root.unmount();
  });
});

describe("billing presentation", () => {
  it("shows the exact trial end and irreversible immediate-billing warning at checkout entry", () => {
    const html = render(
      readyState(
        account({
          status: "TRIAL_ACTIVE",
          trialEndsAt: DateTime.makeUnsafe("2026-08-10T10:15:30.000Z"),
        }),
      ),
    );

    expect(html).toContain("August 10, 2026");
    expect(html).toContain("10:15 AM");
    expect(html).toContain("Billing starts immediately");
    expect(html).toContain("permanently ends any unused trial time");
    expect(html).toContain("Subscribe monthly");
    expect(html).toContain("Subscribe annually");
  });

  it("presents paid-through cancellation without restoring a trial", () => {
    const html = render(
      readyState(
        account({
          status: "PAID_ACTIVE",
          paidThrough: DateTime.makeUnsafe("2026-09-10T10:15:30.000Z"),
          cancelAtPeriodEnd: true,
        }),
      ),
    );

    expect(html).toContain("Subscription canceled");
    expect(html).toContain("September 10, 2026");
    expect(html).toContain("Your trial will not resume");
  });

  it("makes grace recovery prominent and preserves the independent storage blocker", () => {
    const html = render(
      readyState(
        account(
          {
            status: "GRACE_ACTIVE",
            graceEndsAt: DateTime.makeUnsafe("2026-09-03T10:15:30.000Z"),
          },
          ["storage"],
        ),
      ),
    );

    expect(html).toContain("Payment needs attention");
    expect(html).toContain("Recover billing");
    expect(html).toContain("Storage remains separate");
  });

  it("does not claim checkout success while backend entitlement is still trial-active", async () => {
    const refresh = vi.fn().mockResolvedValue(undefined);
    const container = document.createElement("div");
    const root = createRoot(container);
    mountedRoots.push(root);

    await act(async () => {
      root.render(
        <BillingView
          billing={billing}
          checkoutReturned
          onBack={() => undefined}
          onNavigate={() => undefined}
          onSettings={() => undefined}
          onSignOut={() => undefined}
          refresh={refresh}
          state={readyState(
            account({
              status: "TRIAL_ACTIVE",
              trialEndsAt: DateTime.makeUnsafe("2026-08-10T10:15:30.000Z"),
            }),
          )}
          user={user}
        />,
      );
    });

    expect(container.textContent).toContain("Waiting for Polar confirmation");
    expect(container.textContent).not.toContain("Subscription confirmed by Polar");
    expect(refresh).toHaveBeenCalledTimes(1);
  });

  it("serializes confirmation checks, stops at its deadline, and offers manual retry", async () => {
    vi.useFakeTimers();
    const refresh = vi.fn().mockResolvedValue(undefined);
    const container = document.createElement("div");
    const root = createRoot(container);
    mountedRoots.push(root);

    await act(async () => {
      root.render(
        <BillingView
          billing={billing}
          checkoutReturned
          onBack={() => undefined}
          onNavigate={() => undefined}
          onSettings={() => undefined}
          onSignOut={() => undefined}
          refresh={refresh}
          state={readyState(
            account({
              status: "TRIAL_ACTIVE",
              trialEndsAt: DateTime.makeUnsafe("2026-08-10T10:15:30.000Z"),
            }),
          )}
          user={user}
        />,
      );
    });
    await act(async () => {
      await vi.runAllTimersAsync();
    });

    expect(refresh).toHaveBeenCalledTimes(7);
    const retry = Array.from(container.querySelectorAll("button")).find(
      (button) => button.textContent === "Check again",
    );
    expect(retry).toBeDefined();

    await act(async () => {
      retry?.click();
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(refresh).toHaveBeenCalledTimes(8);
  });
});
