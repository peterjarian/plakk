import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import { TestClock } from "effect/testing";
import { describe, expect, it, vi } from "vite-plus/test";

import {
  AccountBilling,
  AccountBillingStateRepository,
  BillingAuthority,
  BillingProviderError,
  GRACE_DURATION_MILLIS,
  type AccountBillingState,
  type BillingAuthoritySnapshot,
} from "./AccountBilling.ts";

const date = (value: string): Date => DateTime.toDateUtc(DateTime.makeUnsafe(value));

const trial = {
  startedAt: date("2026-07-27T10:15:30.000Z"),
  endsAt: date("2026-08-10T10:15:30.000Z"),
};

const authorityUpdatedAt = date("2026-07-27T10:15:30.000Z");
const none = (everPaid = false, updatedAt = authorityUpdatedAt): BillingAuthoritySnapshot => ({
  kind: "NONE",
  everPaid,
  updatedAt,
});

const makeRepository = () => {
  const states = new Map<string, AccountBillingState>();
  const find = vi.fn((workosUserId: string) => Effect.sync(() => states.get(workosUserId) ?? null));
  const save = vi.fn((state: AccountBillingState) =>
    Effect.sync(() => {
      const existing = states.get(state.workosUserId);
      if (
        existing !== undefined &&
        existing.authorityUpdatedAt.getTime() > state.authorityUpdatedAt.getTime()
      ) {
        return existing;
      }
      states.set(state.workosUserId, state);
      return state;
    }),
  );
  return {
    layer: Layer.succeed(
      AccountBillingStateRepository,
      AccountBillingStateRepository.of({ find, save }),
    ),
    states,
  };
};

const makeAuthority = (initial: BillingAuthoritySnapshot = none()) => {
  let snapshot = initial;
  const read = vi.fn(
    (_workosUserId: string): Effect.Effect<BillingAuthoritySnapshot, BillingProviderError> =>
      Effect.succeed(snapshot),
  );
  const beginCheckout = vi.fn((workosUserId: string, plan: "MONTHLY" | "ANNUAL") =>
    Effect.succeed({ url: `https://checkout.example/${workosUserId}/${plan}` }),
  );
  const openPortal = vi.fn((workosUserId: string) =>
    Effect.succeed({ url: `https://portal.example/${workosUserId}` }),
  );
  const verifyWebhook = vi.fn(() => Effect.succeed("user-1" as string | null));
  return {
    layer: Layer.succeed(
      BillingAuthority,
      BillingAuthority.of({ beginCheckout, openPortal, read, verifyWebhook }),
    ),
    set: (next: BillingAuthoritySnapshot) => {
      snapshot = next;
    },
    beginCheckout,
    openPortal,
    read,
    verifyWebhook,
  };
};

const runBilling = <A, E>(
  use: (billing: AccountBilling["Service"]) => Effect.Effect<A, E>,
  options?: {
    readonly authority?: ReturnType<typeof makeAuthority>;
    readonly repository?: ReturnType<typeof makeRepository>;
  },
) => {
  const authority = options?.authority ?? makeAuthority();
  const repository = options?.repository ?? makeRepository();
  const layer = AccountBilling.layer.pipe(
    Layer.provide(authority.layer),
    Layer.provide(repository.layer),
  );
  return Effect.runPromise(
    Effect.gen(function* () {
      const billing = yield* AccountBilling;
      return yield* use(billing);
    }).pipe(Effect.provide(Layer.merge(layer, TestClock.layer())), Effect.orDie),
  );
};

describe("Polar-backed account billing", () => {
  it("uses the dedicated benefit-confirmed paid period and never restores unused trial", async () => {
    const authority = makeAuthority({
      kind: "PAID",
      cancelAtPeriodEnd: false,
      paidThrough: date("2026-08-27T10:15:30.000Z"),
      updatedAt: authorityUpdatedAt,
    });

    const [paid, afterRevocation] = await runBilling(
      (billing) =>
        Effect.gen(function* () {
          yield* TestClock.setTime(Date.parse("2026-07-28T10:15:30.000Z"));
          const paid = yield* billing.getEntitlement("user-1", trial);
          authority.set(none(true, date("2026-08-27T10:15:30.000Z")));
          yield* TestClock.setTime(Date.parse("2026-08-27T10:15:30.000Z"));
          const afterRevocation = yield* billing.getEntitlement("user-1", trial);
          return [paid, afterRevocation] as const;
        }),
      { authority },
    );

    expect(paid).toMatchObject({
      status: "PAID_ACTIVE",
      cancelAtPeriodEnd: false,
    });
    expect(afterRevocation).toEqual({ status: "BILLING_RESTRICTED" });
  });

  it("retains canceled access through the paid-through instant", async () => {
    const authority = makeAuthority({
      kind: "PAID",
      cancelAtPeriodEnd: true,
      paidThrough: date("2026-08-27T10:15:30.000Z"),
      updatedAt: authorityUpdatedAt,
    });

    const [before, atBoundary] = await runBilling(
      (billing) =>
        Effect.gen(function* () {
          yield* TestClock.setTime(Date.parse("2026-08-27T10:15:29.999Z"));
          const before = yield* billing.getEntitlement("user-1", trial);
          authority.set(none(true, date("2026-08-27T10:15:30.000Z")));
          yield* TestClock.setTime(Date.parse("2026-08-27T10:15:30.000Z"));
          const atBoundary = yield* billing.getEntitlement("user-1", trial);
          return [before, atBoundary] as const;
        }),
      { authority },
    );

    expect(before.status).toBe("PAID_ACTIVE");
    expect(atBoundary).toEqual({ status: "BILLING_RESTRICTED" });
  });

  it("grants one non-extending seven-day grace and restricts at its exact expiry", async () => {
    const pastDueAt = date("2026-08-27T10:15:30.000Z");
    const authority = makeAuthority({ kind: "PAST_DUE", pastDueAt, updatedAt: pastDueAt });

    const [first, repeated, atBoundary] = await runBilling(
      (billing) =>
        Effect.gen(function* () {
          yield* TestClock.setTime(pastDueAt.getTime());
          const first = yield* billing.getEntitlement("user-1", trial);
          yield* TestClock.adjust("2 days");
          const repeated = yield* billing.getEntitlement("user-1", trial);
          yield* TestClock.setTime(pastDueAt.getTime() + GRACE_DURATION_MILLIS);
          const atBoundary = yield* billing.getEntitlement("user-1", trial);
          return [first, repeated, atBoundary] as const;
        }),
      { authority },
    );

    expect(first.status).toBe("GRACE_ACTIVE");
    expect(repeated).toEqual(first);
    expect(atBoundary).toEqual({ status: "BILLING_RESTRICTED" });
  });

  it("clears only the billing grace after authoritative recovery", async () => {
    const authority = makeAuthority({
      kind: "PAST_DUE",
      pastDueAt: date("2026-08-27T10:15:30.000Z"),
      updatedAt: date("2026-08-27T10:15:30.000Z"),
    });

    const recovered = await runBilling(
      (billing) =>
        Effect.gen(function* () {
          yield* TestClock.setTime(Date.parse("2026-08-28T10:15:30.000Z"));
          yield* billing.getEntitlement("user-1", trial);
          authority.set({
            kind: "PAID",
            cancelAtPeriodEnd: false,
            paidThrough: date("2026-09-27T10:15:30.000Z"),
            updatedAt: date("2026-08-28T10:15:30.000Z"),
          });
          return yield* billing.getEntitlement("user-1", trial);
        }),
      { authority },
    );

    expect(recovered.status).toBe("PAID_ACTIVE");
  });

  it("uses stored backend-confirmed state during a temporary Polar failure", async () => {
    const authority = makeAuthority({
      kind: "PAID",
      cancelAtPeriodEnd: false,
      paidThrough: date("2026-08-27T10:15:30.000Z"),
      updatedAt: authorityUpdatedAt,
    });

    const entitlement = await runBilling(
      (billing) =>
        Effect.gen(function* () {
          yield* TestClock.setTime(Date.parse("2026-08-01T10:15:30.000Z"));
          yield* billing.getEntitlement("user-1", trial);
          authority.read.mockImplementationOnce(() =>
            Effect.fail(new BillingProviderError({ cause: null, message: "Polar unavailable" })),
          );
          return yield* billing.getEntitlement("user-1", trial);
        }),
      { authority },
    );

    expect(entitlement.status).toBe("PAID_ACTIVE");
  });

  it("does not restore trial when Polar history proves a missed paid period", async () => {
    const authority = makeAuthority(none(true, date("2026-07-30T10:15:30.000Z")));

    const entitlement = await runBilling(
      (billing) =>
        Effect.gen(function* () {
          yield* TestClock.setTime(Date.parse("2026-08-01T10:15:30.000Z"));
          return yield* billing.getEntitlement("user-1", trial);
        }),
      { authority },
    );

    expect(entitlement).toEqual({ status: "BILLING_RESTRICTED" });
  });

  it("does not let an older reconciliation overwrite confirmed recovery", async () => {
    const repository = makeRepository();
    const authority = makeAuthority();

    const [staleStarted, releaseStale] = await Effect.runPromise(
      Effect.all([Deferred.make<void>(), Deferred.make<void>()]),
    );
    authority.read
      .mockImplementationOnce(() =>
        Deferred.succeed(staleStarted, undefined).pipe(
          Effect.andThen(Deferred.await(releaseStale)),
          Effect.as({
            kind: "PAST_DUE" as const,
            pastDueAt: date("2026-08-27T10:15:30.000Z"),
            updatedAt: date("2026-08-27T10:15:30.000Z"),
          }),
        ),
      )
      .mockImplementationOnce(() =>
        Effect.succeed({
          kind: "PAID" as const,
          cancelAtPeriodEnd: false,
          paidThrough: date("2026-09-27T10:15:30.000Z"),
          updatedAt: date("2026-08-28T10:15:30.000Z"),
        }),
      );

    const [recovered, staleResult] = await runBilling(
      (billing) =>
        Effect.gen(function* () {
          yield* TestClock.setTime(Date.parse("2026-08-28T10:15:30.000Z"));
          const staleFiber = yield* Effect.forkChild(billing.getEntitlement("user-1", trial));
          yield* Deferred.await(staleStarted);
          const recoveredFiber = yield* Effect.forkChild(billing.getEntitlement("user-1", trial));
          yield* Deferred.succeed(releaseStale, undefined);
          const staleResult = yield* Fiber.join(staleFiber);
          const recovered = yield* Fiber.join(recoveredFiber);
          return [recovered, staleResult] as const;
        }),
      { authority, repository },
    );

    expect(recovered.status).toBe("PAID_ACTIVE");
    expect(staleResult.status).toBe("GRACE_ACTIVE");
    expect(repository.states.get("user-1")?.authorityStatus).toBe("PAID");
  });

  it("keeps checkout and portal destinations account-bound", async () => {
    const authority = makeAuthority();

    const destinations = await runBilling(
      (billing) =>
        Effect.all([
          billing.beginCheckout("workos-user", "ANNUAL"),
          billing.openPortal("workos-user"),
        ]),
      { authority },
    );

    expect(destinations).toEqual([
      { url: "https://checkout.example/workos-user/ANNUAL" },
      { url: "https://portal.example/workos-user" },
    ]);
    expect(authority.beginCheckout).toHaveBeenCalledWith("workos-user", "ANNUAL");
    expect(authority.openPortal).toHaveBeenCalledWith("workos-user");
  });

  it("reconciles only after a signed state-change webhook resolves an external identity", async () => {
    const authority = makeAuthority();

    await runBilling(
      (billing) => billing.handleWebhook("signed-body", { "webhook-signature": "signature" }),
      { authority },
    );

    expect(authority.verifyWebhook).toHaveBeenCalledWith("signed-body", {
      "webhook-signature": "signature",
    });
    expect(authority.read).toHaveBeenCalledWith("user-1");
  });
});
