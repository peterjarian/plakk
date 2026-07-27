import * as DateTime from "effect/DateTime";
import { describe, expect, it } from "vite-plus/test";

import {
  accountEntitlementExpiryDelayMillis,
  accountWithBillingRestriction,
  type AccountStatus,
} from "./PlakkApi.ts";

const status = (accessEntitlement: AccountStatus["accessEntitlement"]): AccountStatus => ({
  accessEntitlement,
  blockedReasons: ["storage"],
  canSync: false,
  storageProvider: null,
});

describe("account billing capability", () => {
  it.each([
    {
      entitlement: {
        status: "TRIAL_ACTIVE",
        trialEndsAt: DateTime.makeUnsafe("2026-08-10T00:00:00.000Z"),
      } as const,
      expected: 10_000,
    },
    {
      entitlement: {
        status: "PAID_ACTIVE",
        paidThrough: DateTime.makeUnsafe("2026-08-10T00:00:00.000Z"),
        cancelAtPeriodEnd: true,
      } as const,
      expected: 10_000,
    },
    {
      entitlement: {
        status: "GRACE_ACTIVE",
        graceEndsAt: DateTime.makeUnsafe("2026-08-10T00:00:00.000Z"),
      } as const,
      expected: 10_000,
    },
  ])(
    "expires $entitlement.status at its exact backend-provided instant",
    ({ entitlement, expected }) => {
      expect(
        accountEntitlementExpiryDelayMillis(
          status(entitlement),
          Date.parse("2026-08-09T23:59:50.000Z"),
        ),
      ).toBe(expected);
    },
  );

  it("adds only billing restriction and preserves an independent storage restriction", () => {
    expect(
      accountWithBillingRestriction(
        status({
          status: "PAID_ACTIVE",
          paidThrough: DateTime.makeUnsafe("2026-08-10T00:00:00.000Z"),
          cancelAtPeriodEnd: false,
        }),
      ),
    ).toEqual({
      accessEntitlement: { status: "BILLING_RESTRICTED" },
      blockedReasons: ["storage", "billing"],
      canSync: false,
      storageProvider: null,
    });
  });
});
