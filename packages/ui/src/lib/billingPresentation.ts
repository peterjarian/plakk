import type { BillingStatus } from "@plakk/shared/PlakkApi";
import * as DateTime from "effect/DateTime";

export interface BillingPresentation {
  readonly action: "Manage" | "Subscribe";
  readonly description: string;
}

export const billingPresentation = (billing: BillingStatus | null): BillingPresentation => {
  switch (billing?.status) {
    case "SUBSCRIBED":
      return {
        action: "Manage",
        description: billing.cancelAtPeriodEnd
          ? "Subscribed — access continues through the current billing period."
          : "Your Plakk subscription is active.",
      };
    case "FREE_PERIOD":
      return {
        action: "Subscribe",
        description: `Free access through ${new Intl.DateTimeFormat(undefined, {
          dateStyle: "medium",
        }).format(DateTime.toDateUtc(billing.freeUntil))}. No card required.`,
      };
    case "PAYMENT_REQUIRED":
      return {
        action: "Subscribe",
        description: "Your free access has ended. Subscribe to continue using Plakk.",
      };
    default:
      return {
        action: "Subscribe",
        description: "Billing status is unavailable while offline.",
      };
  }
};
