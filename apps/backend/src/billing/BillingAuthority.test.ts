import { createHmac } from "node:crypto";

import type { CustomerState } from "@polar-sh/sdk/models/components/customerstate.js";
import type { Subscription } from "@polar-sh/sdk/models/components/subscription.js";
import * as ConfigProvider from "effect/ConfigProvider";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { describe, expect, it } from "vite-plus/test";

import { BillingAuthority, billingAuthoritySnapshotFromPolar } from "./AccountBilling.ts";

const webhookSecret = "polar-webhook-test-secret";
const date = (value: string) => DateTime.toDateUtc(DateTime.makeUnsafe(value));
const body = JSON.stringify({
  type: "customer.state_changed",
  timestamp: "2026-07-27T10:15:30.000Z",
  data: {
    id: "polar-customer-id",
    created_at: "2026-07-27T10:15:30.000Z",
    modified_at: null,
    metadata: {},
    external_id: "workos-user-1",
    email: "person@example.com",
    email_verified: true,
    type: "individual",
    name: "Person Example",
    billing_name: null,
    billing_address: null,
    tax_id: null,
    locale: null,
    organization_id: "polar-organization-id",
    default_payment_method_id: null,
    deleted_at: null,
    avatar_url: null,
    active_subscriptions: [],
    granted_benefits: [],
    active_meters: [],
  },
});

const signedHeaders = (signedBody: string, secret = webhookSecret) => {
  const id = "webhook-delivery-id";
  const timestamp = Math.floor(DateTime.toEpochMillis(DateTime.nowUnsafe()) / 1_000).toString();
  const signature = createHmac("sha256", secret)
    .update(`${id}.${timestamp}.${signedBody}`)
    .digest("base64");
  return {
    "webhook-id": id,
    "webhook-timestamp": timestamp,
    "webhook-signature": `v1,${signature}`,
  };
};

const configLayer = ConfigProvider.layer(
  ConfigProvider.fromUnknown({
    PLAKK_WEB_ORIGIN: "https://app.plakk.io",
    POLAR_ACCESS_TOKEN: "polar-test-access-token",
    POLAR_ANNUAL_PRODUCT_ID: "annual-product-id",
    POLAR_MONTHLY_PRODUCT_ID: "monthly-product-id",
    POLAR_PAID_BENEFIT_ID: "paid-benefit-id",
    POLAR_SERVER: "sandbox",
    POLAR_WEBHOOK_SECRET: webhookSecret,
  }),
);

const runAuthority = <A, E>(use: (authority: BillingAuthority["Service"]) => Effect.Effect<A, E>) =>
  Effect.runPromise(
    Effect.gen(function* () {
      const authority = yield* BillingAuthority;
      return yield* use(authority);
    }).pipe(Effect.provide(BillingAuthority.layer.pipe(Layer.provide(configLayer))), Effect.result),
  );

describe("Polar webhook boundary", () => {
  it("accepts a valid Standard Webhooks signature and returns the WorkOS external identity", async () => {
    const result = await runAuthority((authority) =>
      authority.verifyWebhook(body, signedHeaders(body)),
    );

    expect(result).toMatchObject({
      _tag: "Success",
      success: "workos-user-1",
    });
  });

  it("rejects a body whose signed payload does not match", async () => {
    const result = await runAuthority((authority) =>
      authority.verifyWebhook(`${body} `, signedHeaders(body)),
    );

    expect(result).toMatchObject({
      _tag: "Failure",
      failure: { _tag: "BillingWebhookVerificationError" },
    });
  });
});

const subscription = (
  status: "active" | "canceled" | "past_due",
  options?: {
    readonly modifiedAt?: Date;
    readonly productId?: string;
  },
) =>
  ({
    cancelAtPeriodEnd: false,
    createdAt: date("2026-07-27T10:15:30.000Z"),
    currentPeriodEnd: date("2026-08-27T10:15:30.000Z"),
    modifiedAt: options?.modifiedAt ?? date("2026-07-27T10:15:30.000Z"),
    pastDueAt: status === "past_due" ? date("2026-07-28T10:15:30.000Z") : null,
    productId: options?.productId ?? "monthly-product-id",
    status,
  }) as Subscription;

const customerState = (benefitIds: ReadonlyArray<string>) =>
  ({
    createdAt: date("2026-07-27T10:15:30.000Z"),
    grantedBenefits: benefitIds.map((benefitId) => ({ benefitId })),
    modifiedAt: date("2026-07-29T10:15:30.000Z"),
  }) as CustomerState;

describe("Polar customer-state normalization", () => {
  it("uses the configured benefit and active recurring product before unrelated past-due history", () => {
    const snapshot = billingAuthoritySnapshotFromPolar(
      customerState(["paid-benefit-id"]),
      [
        subscription("active", {
          modifiedAt: date("2026-07-29T10:15:30.000Z"),
        }),
        subscription("past_due", {
          modifiedAt: date("2026-07-28T10:15:30.000Z"),
          productId: "annual-product-id",
        }),
      ],
      {
        paidBenefitId: "paid-benefit-id",
        productIds: ["monthly-product-id", "annual-product-id"],
      },
    );

    expect(snapshot).toMatchObject({
      kind: "PAID",
      paidThrough: date("2026-08-27T10:15:30.000Z"),
    });
  });

  it("retains paid history after Polar revokes the active benefit", () => {
    const snapshot = billingAuthoritySnapshotFromPolar(
      customerState([]),
      [subscription("canceled")],
      {
        paidBenefitId: "paid-benefit-id",
        productIds: ["monthly-product-id", "annual-product-id"],
      },
    );

    expect(snapshot).toMatchObject({
      kind: "NONE",
      everPaid: true,
    });
  });
});
