import { describe, expect, it } from "vite-plus/test";
import * as Effect from "effect/Effect";
import * as Ref from "effect/Ref";

import {
  desktopBillingCallbackUrl,
  makeBillingReturnCoordinator,
  parseTrustedBillingCallbackUrl,
  refreshBillingUntilSubscribed,
} from "./BillingCallback.ts";

describe("desktop billing callback", () => {
  it("uses separate development and packaged protocols", () => {
    expect(desktopBillingCallbackUrl(false).href).toBe("plakk-dev://billing/success");
    expect(desktopBillingCallbackUrl(true).href).toBe("plakk://billing/success");
  });

  it("accepts only the exact billing callback address", () => {
    const callbackUrl = desktopBillingCallbackUrl(false);

    expect(parseTrustedBillingCallbackUrl("plakk-dev://billing/success", callbackUrl)?.href).toBe(
      "plakk-dev://billing/success",
    );
    expect(parseTrustedBillingCallbackUrl("plakk://billing/success", callbackUrl)).toBeNull();
    expect(parseTrustedBillingCallbackUrl("plakk-dev://auth/callback", callbackUrl)).toBeNull();
    expect(
      parseTrustedBillingCallbackUrl(
        "plakk-dev://billing/success?redirect=https://evil.test",
        callbackUrl,
      ),
    ).toBeNull();
    expect(parseTrustedBillingCallbackUrl("not a url", callbackUrl)).toBeNull();
  });

  it("queues a second return while the current refresh is active", () => {
    const returns = makeBillingReturnCoordinator();

    returns.request();
    expect(returns.start()).toBe(true);
    returns.request();
    expect(returns.start()).toBe(false);
    expect(returns.finish()).toBe(true);
    expect(returns.start()).toBe(true);
    expect(returns.finish()).toBe(false);
    expect(returns.hasPendingReturn()).toBe(false);
  });

  it("refreshes until Polar reports the subscription", async () => {
    const attempts = await Effect.runPromise(
      Effect.gen(function* () {
        const refreshes = yield* Ref.make(0);
        const subscribed = yield* refreshBillingUntilSubscribed({
          refresh: Ref.update(refreshes, (count) => count + 1),
          isSubscribed: Ref.get(refreshes).pipe(Effect.map((count) => count === 3)),
          attempts: 5,
          interval: 0,
        });
        expect(subscribed).toBe(true);
        return yield* Ref.get(refreshes);
      }),
    );

    expect(attempts).toBe(3);
  });

  it("stops after the bounded refresh window", async () => {
    const attempts = await Effect.runPromise(
      Effect.gen(function* () {
        const refreshes = yield* Ref.make(0);
        const subscribed = yield* refreshBillingUntilSubscribed({
          refresh: Ref.update(refreshes, (count) => count + 1),
          isSubscribed: Effect.succeed(false),
          attempts: 3,
          interval: 0,
        });
        expect(subscribed).toBe(false);
        return yield* Ref.get(refreshes);
      }),
    );

    expect(attempts).toBe(3);
  });

  it("keeps refresh failures bounded", async () => {
    const attempts = await Effect.runPromise(
      Effect.gen(function* () {
        const refreshes = yield* Ref.make(0);
        const subscribed = yield* refreshBillingUntilSubscribed({
          refresh: Ref.update(refreshes, (count) => count + 1).pipe(
            Effect.andThen(Effect.fail("offline")),
          ),
          isSubscribed: Effect.succeed(false),
          attempts: 3,
          interval: 0,
        });
        expect(subscribed).toBe(false);
        return yield* Ref.get(refreshes);
      }),
    );

    expect(attempts).toBe(3);
  });
});
