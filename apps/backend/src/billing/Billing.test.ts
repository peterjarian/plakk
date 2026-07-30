import { it } from "@effect/vitest";
import type { Polar } from "@polar-sh/sdk/2026-04";
import * as ConfigProvider from "effect/ConfigProvider";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as TestClock from "effect/testing/TestClock";
import { Persistence } from "effect/unstable/persistence";
import { expect } from "vite-plus/test";

import {
  Billing,
  BillingIdentityError,
  PaymentRequiredError,
  PolarBilling,
  PolarBillingError,
  PolarCustomerStateError,
  makePolarBilling,
} from "./Billing.ts";

const config = (productIds = "product_plakk_monthly,product_plakk_yearly") =>
  ConfigProvider.layer(
    ConfigProvider.fromEnv({
      env: {
        PLAKK_WEB_ORIGIN: "https://app.plakk.test",
        POLAR_ACCESS_BENEFIT_ID: "benefit_plakk_access",
        POLAR_ENVIRONMENT: "sandbox",
        POLAR_PRODUCT_IDS: productIds,
      },
    }),
  );

const accessBenefit = {
  benefit_id: "benefit_plakk_access",
  benefit_type: "feature_flag",
};

const customerAccess = (
  subscriptions: ReadonlyArray<{
    readonly cancel_at_period_end: boolean;
  }> = [],
  benefits: ReadonlyArray<{
    readonly benefit_id: string;
    readonly benefit_type: string;
  }> = [],
) => ({
  _tag: "Found" as const,
  snapshot: { active_subscriptions: subscriptions, granted_benefits: benefits },
});

const subscription = {
  id: "subscription_1",
  product_id: "product_plakk_monthly",
  status: "active",
  current_period_end: "2026-08-30T00:00:00.000Z",
  cancel_at_period_end: false,
};
const freeUntil = DateTime.makeUnsafe("2099-01-01T00:00:00.000Z");

const runBilling = <A, E>(
  polar: PolarBilling["Service"],
  effect: Effect.Effect<A, E, Billing>,
  configLayer = config(),
  useTestClock = false,
) => {
  const program = effect.pipe(
    Effect.provide(
      Billing.layer.pipe(
        Layer.provide(Layer.succeed(PolarBilling, polar)),
        Layer.provide(Persistence.layerMemory),
      ),
    ),
    Effect.provide(configLayer),
    Effect.scoped,
  );
  return Effect.runPromise(
    useTestClock ? program.pipe(Effect.provide(TestClock.layer())) : program,
  );
};

it.effect("projects Polar Customer State before it reaches persistence", () =>
  Effect.gen(function* () {
    const polar = {
      customers: {
        getStateExternal: () =>
          Promise.resolve({
            active_subscriptions: [subscription],
            granted_benefits: [accessBenefit],
            email: "private@example.com",
            billing_address: { line1: "Private" },
            tax_id: ["private"],
            default_payment_method_id: "payment_method_private",
          }),
      },
    } as unknown as Polar;

    expect(yield* makePolarBilling(polar).getCustomerState("user_1")).toEqual(
      customerAccess(
        [
          {
            cancel_at_period_end: subscription.cancel_at_period_end,
          },
        ],
        [accessBenefit],
      ),
    );
  }),
);

it.effect("bounds Polar Customer State requests", () =>
  Effect.gen(function* () {
    const polar = {
      customers: {
        getStateExternal: () => new Promise<never>(() => {}),
      },
    } as unknown as Polar;
    const failure = yield* makePolarBilling(polar)
      .getCustomerState("user_1")
      .pipe(Effect.flip, Effect.forkChild);

    yield* TestClock.adjust("5 seconds");
    expect(yield* Fiber.join(failure)).toMatchObject({
      _tag: "PolarBillingError",
      operation: "getCustomerState",
    });
  }),
);

it("reuses the cached customer access state", async () => {
  let requests = 0;
  const polar = PolarBilling.of({
    getCustomerState: () =>
      Effect.sync(() => {
        requests += 1;
        return customerAccess();
      }),
    createCheckout: () => Effect.succeed("https://checkout.example"),
    createPortalSession: () => Effect.succeed("https://portal.example"),
  });

  await runBilling(
    polar,
    Effect.gen(function* () {
      const billing = yield* Billing;
      const user = { id: "user_1" };
      yield* billing.status(user);
      yield* billing.status(user);
      expect(requests).toBe(1);
    }),
  );
});

it("uses the signed free-period deadline when no Polar customer exists", async () => {
  const polar = PolarBilling.of({
    getCustomerState: () => Effect.succeed({ _tag: "NotFound" }),
    createCheckout: () => Effect.succeed("https://checkout.example"),
    createPortalSession: () => Effect.succeed("https://portal.example"),
  });

  const result = await runBilling(
    polar,
    Effect.gen(function* () {
      const billing = yield* Billing;
      return yield* billing.status({
        id: "user_1",
        freeUntil,
      });
    }),
  );

  expect(result).toEqual({
    status: "FREE_PERIOD",
    freeUntil,
  });
});

it("keeps a Free Period usable when Polar is temporarily unavailable", async () => {
  let requests = 0;
  const polar = PolarBilling.of({
    getCustomerState: () =>
      Effect.sync(() => {
        requests += 1;
      }).pipe(
        Effect.andThen(
          Effect.fail(
            new PolarBillingError({
              operation: "getCustomerState",
              message: "Polar is unavailable.",
            }),
          ),
        ),
      ),
    createCheckout: () => Effect.succeed("https://checkout.example"),
    createPortalSession: () => Effect.succeed("https://portal.example"),
  });

  const result = await runBilling(
    polar,
    Effect.gen(function* () {
      const billing = yield* Billing;
      return yield* billing.status({
        id: "user_1",
        freeUntil,
      });
    }),
  );

  expect(result.status).toBe("FREE_PERIOD");
  expect(requests).toBe(1);
});

it("does not hide an invalid Polar contract behind a Free Period", async () => {
  const polar = PolarBilling.of({
    getCustomerState: () =>
      Effect.fail(
        new PolarCustomerStateError({
          message: "Polar returned an invalid Customer State.",
        }),
      ),
    createCheckout: () => Effect.succeed("https://checkout.example"),
    createPortalSession: () => Effect.succeed("https://portal.example"),
  });

  await expect(
    runBilling(
      polar,
      Effect.gen(function* () {
        const billing = yield* Billing;
        return yield* billing.status({ id: "user_1", freeUntil });
      }),
    ),
  ).rejects.toMatchObject({ _tag: "PolarCustomerStateError" });
});

it("opens checkout, invalidates stale state, and detects payment without a success redirect", async () => {
  let paid = false;
  let requests = 0;
  let checkoutProductIds: ReadonlyArray<string> = [];
  let checkoutReturnUrl = "";
  let checkoutSuccessUrl = "";
  const polar = PolarBilling.of({
    getCustomerState: () =>
      Effect.sync(() => {
        requests += 1;
        return customerAccess(paid ? [subscription] : [], paid ? [accessBenefit] : []);
      }),
    createCheckout: (input) =>
      Effect.sync(() => {
        checkoutProductIds = input.productIds;
        checkoutReturnUrl = input.returnUrl;
        checkoutSuccessUrl = input.successUrl;
        paid = true;
        return "https://checkout.example";
      }),
    createPortalSession: () => Effect.succeed("https://portal.example"),
  });

  await runBilling(
    polar,
    Effect.gen(function* () {
      const billing = yield* Billing;
      const user = { id: "user_1", email: "user@example.com" };
      expect(yield* billing.open(user, "DESKTOP")).toBe("https://checkout.example");
      expect(checkoutProductIds).toEqual(["product_plakk_monthly", "product_plakk_yearly"]);
      expect(checkoutReturnUrl).toBe("https://app.plakk.test/billing/desktop-return");
      expect(checkoutSuccessUrl).toBe("https://app.plakk.test/billing/desktop-return");
      expect(yield* billing.status(user)).toEqual({
        status: "SUBSCRIBED",
        cancelAtPeriodEnd: false,
      });
      expect(requests).toBe(2);
    }),
  );
});

it("returns desktop portal sessions and refreshes their customer state", async () => {
  let portalReturnUrl = "";
  let cancelAtPeriodEnd = false;
  let requests = 0;
  const polar = PolarBilling.of({
    getCustomerState: () =>
      Effect.sync(() => {
        requests += 1;
        return customerAccess(
          [{ ...subscription, cancel_at_period_end: cancelAtPeriodEnd }],
          [accessBenefit],
        );
      }),
    createCheckout: () => Effect.succeed("https://checkout.example"),
    createPortalSession: (input) =>
      Effect.sync(() => {
        portalReturnUrl = input.returnUrl;
        return "https://portal.example";
      }),
  });

  await runBilling(
    polar,
    Effect.gen(function* () {
      const billing = yield* Billing;
      const user = { id: "user_1" };
      expect(yield* billing.open(user, "DESKTOP")).toBe("https://portal.example");
      cancelAtPeriodEnd = true;
      yield* billing.invalidateCustomerAccessSnapshot(user);
      expect(yield* billing.status(user)).toEqual({
        status: "SUBSCRIBED",
        cancelAtPeriodEnd: true,
      });
    }),
  );

  expect(portalReturnUrl).toBe("https://app.plakk.test/billing/desktop-return");
  expect(requests).toBe(2);
});

it("uses the web success route for browser checkout", async () => {
  let checkoutSuccessUrl = "";
  const polar = PolarBilling.of({
    getCustomerState: () => Effect.succeed(customerAccess()),
    createCheckout: (input) =>
      Effect.sync(() => {
        checkoutSuccessUrl = input.successUrl;
        return "https://checkout.example";
      }),
    createPortalSession: () => Effect.succeed("https://portal.example"),
  });

  await runBilling(
    polar,
    Effect.gen(function* () {
      const billing = yield* Billing;
      yield* billing.open({ id: "user_1", email: "user@example.com" }, "WEB");
    }),
  );

  expect(checkoutSuccessUrl).toBe("https://app.plakk.test/?billing=success");
});

it("requires a signed email address before opening checkout", async () => {
  const polar = PolarBilling.of({
    getCustomerState: () => Effect.succeed(customerAccess()),
    createCheckout: () => Effect.succeed("https://checkout.example"),
    createPortalSession: () => Effect.succeed("https://portal.example"),
  });

  await expect(
    runBilling(
      polar,
      Effect.gen(function* () {
        const billing = yield* Billing;
        return yield* billing.open({ id: "user_1" }, "WEB");
      }),
    ),
  ).rejects.toBeInstanceOf(BillingIdentityError);
});

it("requires payment only after the free period and benefit access are absent", async () => {
  let access = customerAccess();
  const polar = PolarBilling.of({
    getCustomerState: () => Effect.succeed(access),
    createCheckout: () => Effect.succeed("https://checkout.example"),
    createPortalSession: () => Effect.succeed("https://portal.example"),
  });

  await runBilling(
    polar,
    Effect.gen(function* () {
      const billing = yield* Billing;
      yield* billing.requireAccess({ id: "free_user", freeUntil });

      access = customerAccess([subscription], [accessBenefit]);
      yield* billing.requireAccess({ id: "subscribed_user" });

      access = customerAccess();
      const error = yield* billing.requireAccess({ id: "unpaid_user" }).pipe(Effect.flip);
      expect(error).toBeInstanceOf(PaymentRequiredError);
    }),
  );
});

it("authorizes the shared feature flag benefit", async () => {
  const polar = PolarBilling.of({
    getCustomerState: () =>
      Effect.succeed(
        customerAccess(
          [
            {
              ...subscription,
              cancel_at_period_end: true,
            },
          ],
          [accessBenefit],
        ),
      ),
    createCheckout: () => Effect.succeed("https://checkout.example"),
    createPortalSession: () => Effect.succeed("https://portal.example"),
  });

  const result = await runBilling(
    polar,
    Effect.gen(function* () {
      const billing = yield* Billing;
      return yield* billing.status({ id: "user_1" });
    }),
  );

  expect(result).toEqual({
    status: "SUBSCRIBED",
    cancelAtPeriodEnd: true,
  });
});

it("does not authorize a subscription without the access benefit", async () => {
  const polar = PolarBilling.of({
    getCustomerState: () => Effect.succeed(customerAccess([subscription])),
    createCheckout: () => Effect.succeed("https://checkout.example"),
    createPortalSession: () => Effect.succeed("https://portal.example"),
  });

  const result = await runBilling(
    polar,
    Effect.gen(function* () {
      const billing = yield* Billing;
      return yield* billing.status({ id: "user_1" });
    }),
  );

  expect(result).toEqual({ status: "PAYMENT_REQUIRED" });
});

it("rejects a checkout catalog without monthly and yearly products", async () => {
  const polar = PolarBilling.of({
    getCustomerState: () => Effect.succeed(customerAccess()),
    createCheckout: () => Effect.succeed("https://checkout.example"),
    createPortalSession: () => Effect.succeed("https://portal.example"),
  });

  await expect(
    runBilling(
      polar,
      Effect.gen(function* () {
        return yield* Billing;
      }),
      config("product_plakk_monthly"),
    ),
  ).rejects.toMatchObject({ _tag: "ConfigError" });
});

it("rejects duplicate checkout products", async () => {
  const polar = PolarBilling.of({
    getCustomerState: () => Effect.succeed(customerAccess()),
    createCheckout: () => Effect.succeed("https://checkout.example"),
    createPortalSession: () => Effect.succeed("https://portal.example"),
  });

  await expect(
    runBilling(
      polar,
      Effect.gen(function* () {
        return yield* Billing;
      }),
      config("product_plakk_monthly,product_plakk_monthly"),
    ),
  ).rejects.toMatchObject({ _tag: "ConfigError" });
});

it("throttles repeated pending-checkout refreshes", async () => {
  let requests = 0;
  const polar = PolarBilling.of({
    getCustomerState: () =>
      Effect.sync(() => {
        requests += 1;
        return customerAccess();
      }),
    createCheckout: () => Effect.succeed("https://checkout.example"),
    createPortalSession: () => Effect.succeed("https://portal.example"),
  });

  await runBilling(
    polar,
    Effect.gen(function* () {
      const billing = yield* Billing;
      const user = { id: "user_1", email: "user@example.com" };
      yield* billing.open(user, "WEB");
      yield* billing.status(user);
      yield* billing.status(user);
      expect(requests).toBe(2);
    }),
    config(),
    true,
  );
});

it("returns to the normal customer-state cache after the checkout refresh window", async () => {
  let requests = 0;
  const polar = PolarBilling.of({
    getCustomerState: () =>
      Effect.sync(() => {
        requests += 1;
        return customerAccess();
      }),
    createCheckout: () => Effect.succeed("https://checkout.example"),
    createPortalSession: () => Effect.succeed("https://portal.example"),
  });

  await runBilling(
    polar,
    Effect.gen(function* () {
      const billing = yield* Billing;
      const user = { id: "user_1", email: "user@example.com" };
      yield* billing.open(user, "DESKTOP");
      yield* billing.status(user);
      expect(requests).toBe(2);

      yield* TestClock.adjust("3 seconds");
      yield* billing.status(user);
      expect(requests).toBe(3);

      yield* TestClock.adjust("30 seconds");
      yield* billing.status(user);
      expect(requests).toBe(3);
    }),
    config(),
    true,
  );
});
