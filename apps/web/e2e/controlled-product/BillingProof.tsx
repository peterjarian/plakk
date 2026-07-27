import type { User } from "@plakk/shared";
import type { AccountStatus, BillingPlan } from "@plakk/shared/PlakkApi";
import { Button } from "@plakk/ui/components/primitives/button";
import * as DateTime from "effect/DateTime";
import { useState } from "react";

import type { AccountProductState } from "../../src/product/account-product-lifetime.ts";
import { BillingView } from "../../src/product/BillingView.tsx";

const user: User = {
  id: "workos-controlled-user",
  email: "billing-proof@example.com",
  firstName: "Billing",
  lastName: "Proof",
  createdAt: "2026-07-27T00:00:00.000Z",
  updatedAt: "2026-07-27T00:00:00.000Z",
};

const entitlementFor = (
  mode: "grace" | "recovered" | "restricted" | "returned" | "trial",
): AccountStatus["accessEntitlement"] => {
  switch (mode) {
    case "grace":
      return {
        status: "GRACE_ACTIVE",
        graceEndsAt: DateTime.makeUnsafe("2026-09-03T10:15:30.000Z"),
      };
    case "recovered":
      return {
        status: "PAID_ACTIVE",
        paidThrough: DateTime.makeUnsafe("2026-09-27T10:15:30.000Z"),
        cancelAtPeriodEnd: false,
      };
    case "restricted":
      return { status: "BILLING_RESTRICTED" };
    case "returned":
    case "trial":
      return {
        status: "TRIAL_ACTIVE",
        trialEndsAt: DateTime.makeUnsafe("2026-08-10T10:15:30.000Z"),
      };
  }
};

const stateFor = (
  mode: "grace" | "recovered" | "restricted" | "returned" | "trial",
  storageRestricted: boolean,
): AccountProductState => {
  const billingRestricted = mode === "restricted";
  const account: AccountStatus = {
    accessEntitlement: entitlementFor(mode),
    blockedReasons: [
      ...(billingRestricted ? (["billing"] as const) : []),
      ...(storageRestricted ? (["storage"] as const) : []),
    ],
    canSync: !billingRestricted && !storageRestricted,
    storageProvider: "GOOGLE_DRIVE",
  };
  return {
    account,
    accountId: user.id,
    apiAvailability: "available",
    kind: "ready",
    liveConnection: "connected",
    localReadPerformance: "accelerated",
    snippets: [],
  };
};

export function BillingProof(props: {
  readonly mode: "grace" | "recovered" | "restricted" | "returned" | "trial";
  readonly storageRestricted: boolean;
}) {
  const { mode, storageRestricted } = props;
  const [state, setState] = useState(() => stateFor(mode, storageRestricted));
  const [destination, setDestination] = useState<string | null>(null);

  const recordCheckout = (plan: BillingPlan) => {
    document.documentElement.dataset.billingRequest = JSON.stringify({
      externalCustomerId: user.id,
      plan,
    });
    return Promise.resolve({ url: `https://sandbox.polar.sh/checkout/${plan.toLowerCase()}` });
  };
  const recordPortal = () => {
    document.documentElement.dataset.portalRequest = JSON.stringify({
      externalCustomerId: user.id,
    });
    return Promise.resolve({ url: "https://sandbox.polar.sh/customer-portal/session" });
  };

  return (
    <>
      <BillingView
        billing={{ beginCheckout: recordCheckout, openPortal: recordPortal }}
        checkoutReturned={mode === "returned"}
        onBack={() => {
          document.documentElement.dataset.backRequested = "true";
        }}
        onNavigate={(url) => {
          setDestination(url);
          document.documentElement.dataset.billingDestination = url;
        }}
        onSettings={() => {
          document.documentElement.dataset.settingsRequested = "true";
        }}
        onSignOut={() => {
          document.documentElement.dataset.signOutRequested = "true";
        }}
        refresh={() => {
          document.documentElement.dataset.billingRefreshCount = String(
            Number(document.documentElement.dataset.billingRefreshCount ?? "0") + 1,
          );
          return Promise.resolve();
        }}
        state={state}
        user={user}
      />
      <aside
        aria-label="Controlled billing authority"
        className="fixed right-3 bottom-3 flex gap-2 rounded-lg border bg-background p-2 shadow"
      >
        <Button
          type="button"
          size="sm"
          onClick={() => setState(stateFor("recovered", storageRestricted))}
        >
          Confirm paid benefit
        </Button>
      </aside>
      {destination !== null && <output className="sr-only">Destination: {destination}</output>}
    </>
  );
}
