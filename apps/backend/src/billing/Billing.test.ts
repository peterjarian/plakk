import { it } from "@effect/vitest";
import * as ConfigProvider from "effect/ConfigProvider";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { Persistence } from "effect/unstable/persistence";
import { expect } from "vite-plus/test";

import { Billing, PolarBilling, PolarBillingError } from "./Billing.ts";

const config = ConfigProvider.layer(
  ConfigProvider.fromEnv({
    env: {
      PLAKK_WEB_ORIGIN: "https://app.plakk.test",
      POLAR_ENVIRONMENT: "sandbox",
      POLAR_PRODUCT_ID: "product_plakk",
    },
  }),
);

const state = (subscriptions: ReadonlyArray<Record<string, unknown>> = []) => ({
  _tag: "Found" as const,
  state: { active_subscriptions: subscriptions },
});

const subscription = {
  id: "subscription_1",
  product_id: "product_plakk",
  status: "active",
  current_period_end: "2026-08-30T00:00:00.000Z",
  cancel_at_period_end: false,
};
const freeUntil = DateTime.makeUnsafe("2099-01-01T00:00:00.000Z");

const runBilling = <A, E>(polar: PolarBilling["Service"], effect: Effect.Effect<A, E, Billing>) =>
  Effect.runPromise(
    effect.pipe(
      Effect.provide(
        Billing.layer.pipe(
          Layer.provide(Layer.succeed(PolarBilling, polar)),
          Layer.provide(Persistence.layerMemory),
        ),
      ),
      Effect.provide(config),
      Effect.scoped,
    ),
  );

it("reuses the cached full customer state", async () => {
  let requests = 0;
  const polar = PolarBilling.of({
    getCustomerState: () =>
      Effect.sync(() => {
        requests += 1;
        return state();
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
      Effect.succeed({
        _tag: "Found",
        state: { active_subscriptions: "not-an-array" },
      }),
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
  ).rejects.toMatchObject({ _tag: "SchemaError" });
});

it("opens checkout, invalidates stale state, and detects payment without a success redirect", async () => {
  let paid = false;
  let requests = 0;
  const polar = PolarBilling.of({
    getCustomerState: () =>
      Effect.sync(() => {
        requests += 1;
        return state(paid ? [subscription] : []);
      }),
    createCheckout: () =>
      Effect.sync(() => {
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
      expect(yield* billing.open(user)).toBe("https://checkout.example");
      expect(yield* billing.status(user)).toEqual({
        status: "SUBSCRIBED",
        cancelAtPeriodEnd: false,
      });
      expect(requests).toBe(2);
    }),
  );
});

it("throttles repeated pending-checkout refreshes", async () => {
  let requests = 0;
  const polar = PolarBilling.of({
    getCustomerState: () =>
      Effect.sync(() => {
        requests += 1;
        return state();
      }),
    createCheckout: () => Effect.succeed("https://checkout.example"),
    createPortalSession: () => Effect.succeed("https://portal.example"),
  });

  await runBilling(
    polar,
    Effect.gen(function* () {
      const billing = yield* Billing;
      const user = { id: "user_1", email: "user@example.com" };
      yield* billing.open(user);
      yield* billing.status(user);
      yield* billing.status(user);
      expect(requests).toBe(2);
    }),
  );
});
