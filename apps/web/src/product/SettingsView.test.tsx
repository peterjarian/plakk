import type { User } from "@plakk/shared";
import type { AccountAccessEntitlement, AccountStatus } from "@plakk/shared/PlakkApi";
import * as DateTime from "effect/DateTime";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vite-plus/test";

import { SettingsView } from "./SettingsView.tsx";
import { AccountProductLifetimeInitializationFailure } from "./account-product-lifetime.ts";
import type { WebAppearancePreference } from "./web-appearance.tsx";

const user: User = {
  id: "user_1",
  email: "reader@example.com",
  firstName: "Web",
  lastName: "Reader",
  createdAt: "2026-07-27T00:00:00.000Z",
  updatedAt: "2026-07-27T00:00:00.000Z",
};

const account = (
  accessEntitlement: AccountAccessEntitlement,
  overrides: Partial<AccountStatus> = {},
): AccountStatus => ({
  accessEntitlement,
  blockedReasons: [],
  canSync: true,
  storageProvider: "GOOGLE_DRIVE",
  ...overrides,
});

const render = (currentAccount: AccountStatus, appearance: WebAppearancePreference = "system") =>
  renderToStaticMarkup(
    <SettingsView
      appearance={appearance}
      onAppearanceChange={vi.fn()}
      onBack={vi.fn()}
      onBilling={vi.fn()}
      onSignOut={vi.fn()}
      onStorage={vi.fn()}
      state={{
        account: currentAccount,
        accountId: user.id,
        apiAvailability: "available",
        kind: "ready",
        liveConnection: "connected",
        localReadPerformance: "accelerated",
        snippets: [],
      }}
      user={user}
    />,
  );

describe("Web Settings", () => {
  it("contains account identity and only Web-relevant sections", () => {
    const html = render(
      account({
        status: "TRIAL_ACTIVE",
        trialEndsAt: DateTime.makeUnsafe("2026-08-10T10:15:30.000Z"),
      }),
    );

    expect(html).toContain("Web Reader");
    expect(html).toContain("reader@example.com");
    expect(html).toContain("Trial active");
    expect(html).toContain("August 10, 2026");
    expect(html).toContain("Billing starts immediately");
    expect(html).toContain("Google Drive connected");
    expect(html).toContain("Appearance");
    expect(html).toContain("Contact Plakk help");
    expect(html).toContain(">Sign out</button>");

    for (const desktopOnly of [
      "Toolbar widget",
      "Device storage",
      "Free up space",
      "Auto update",
      "Plakk Desktop",
      "Logs",
      "diagnostic",
      "managed content",
    ]) {
      expect(html).not.toContain(desktopOnly);
    }
  });

  it("shows exact paid, canceled, grace, and restricted billing states", () => {
    const paid = render(
      account({
        status: "PAID_ACTIVE",
        paidThrough: DateTime.makeUnsafe("2026-09-20T12:30:00.000Z"),
        cancelAtPeriodEnd: false,
      }),
    );
    expect(paid).toContain("Paid access active");
    expect(paid).toContain("September 20, 2026");
    expect(paid).toContain(">Manage billing</button>");

    const canceled = render(
      account({
        status: "PAID_ACTIVE",
        paidThrough: DateTime.makeUnsafe("2026-09-20T12:30:00.000Z"),
        cancelAtPeriodEnd: true,
      }),
    );
    expect(canceled).toContain("Subscription canceled");
    expect(canceled).toContain("Access remains active through");

    const grace = render(
      account({
        status: "GRACE_ACTIVE",
        graceEndsAt: DateTime.makeUnsafe("2026-09-03T10:15:30.000Z"),
      }),
    );
    expect(grace).toContain("Payment needs attention");
    expect(grace).toContain("September 3, 2026");
    expect(grace).toContain(">Recover billing</button>");

    const restricted = render(
      account({ status: "BILLING_RESTRICTED" }, { blockedReasons: ["billing"], canSync: false }),
    );
    expect(restricted).toContain("Billing access required");
    expect(restricted).toContain("Your snippets and provider content are preserved");
    expect(restricted).toContain(">Restore billing</button>");
  });

  it("presents connected, reconnecting, and absent storage independently of billing", () => {
    const simultaneous = render(
      account(
        { status: "BILLING_RESTRICTED" },
        { blockedReasons: ["billing", "storage"], canSync: false },
      ),
    );
    expect(simultaneous).toContain("Billing access required");
    expect(simultaneous).toContain("Google Drive needs reconnection");
    expect(simultaneous).toContain("Storage recovery remains independent of billing recovery");
    expect(simultaneous).toContain(">Reconnect storage</button>");

    const absent = render(
      account(
        {
          status: "TRIAL_ACTIVE",
          trialEndsAt: DateTime.makeUnsafe("2026-08-10T10:15:30.000Z"),
        },
        { blockedReasons: ["storage"], canSync: false, storageProvider: null },
      ),
    );
    expect(absent).toContain("No storage connected");
    expect(absent).toContain(">Connect storage</button>");
  });

  it("shows the persisted appearance preference", () => {
    const html = render(
      account({
        status: "TRIAL_ACTIVE",
        trialEndsAt: DateTime.makeUnsafe("2026-08-10T10:15:30.000Z"),
      }),
      "dark",
    );

    expect(html).toContain('aria-label="Appearance"');
    expect(html).toContain(">Dark<");
  });

  it("does not claim storage is absent while authoritative state is loading or failed", () => {
    const common = {
      appearance: "system" as const,
      onAppearanceChange: vi.fn(),
      onBack: vi.fn(),
      onBilling: vi.fn(),
      onSignOut: vi.fn(),
      onStorage: vi.fn(),
      user,
    };
    const loading = renderToStaticMarkup(
      <SettingsView {...common} state={{ accountId: user.id, kind: "loading" }} />,
    );
    expect(loading).toContain("Loading connected storage");
    expect(loading).not.toContain("No storage connected");

    const failed = renderToStaticMarkup(
      <SettingsView
        {...common}
        state={{
          accountId: user.id,
          cause: new AccountProductLifetimeInitializationFailure({ cause: "controlled" }),
          kind: "failed",
        }}
      />,
    );
    expect(failed).toContain("Storage status unavailable");
    expect(failed).not.toContain("No storage connected");
  });
});
