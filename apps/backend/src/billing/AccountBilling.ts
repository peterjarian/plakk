import { Polar } from "@polar-sh/sdk";
import type { CustomerState } from "@polar-sh/sdk/models/components/customerstate.js";
import type { Subscription } from "@polar-sh/sdk/models/components/subscription.js";
import { ResourceNotFound } from "@polar-sh/sdk/models/errors/resourcenotfound.js";
import {
  validateEvent,
  WebhookVerificationError as PolarWebhookVerificationError,
} from "@polar-sh/sdk/webhooks";
import { Drizzle, eq, sql } from "@plakk/db";
import { accountBillingStates } from "@plakk/db/schema";
import { parseExactHttpOrigin } from "@plakk/shared/ExactHttpOrigin";
import type { AccountAccessEntitlement, BillingPlan } from "@plakk/shared/PlakkApi";
import * as Config from "effect/Config";
import * as Context from "effect/Context";
import * as Data from "effect/Data";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import * as Semaphore from "effect/Semaphore";

export const GRACE_DURATION_MILLIS = 7 * 24 * 60 * 60 * 1_000;
export const BILLING_RECONCILIATION_FRESH_MILLIS = 5_000;
const BILLING_PROVIDER_TIMEOUT = "8 seconds";

export type BillingAuthoritySnapshot =
  | {
      readonly kind: "NONE";
      readonly everPaid: boolean;
      readonly updatedAt: Date;
    }
  | {
      readonly kind: "PAID";
      readonly paidThrough: Date;
      readonly cancelAtPeriodEnd: boolean;
      readonly updatedAt: Date;
    }
  | {
      readonly kind: "PAST_DUE";
      readonly pastDueAt: Date;
      readonly updatedAt: Date;
    };

export type AccountBillingState = {
  readonly workosUserId: string;
  readonly authorityStatus: "NONE" | "PAID" | "PAST_DUE";
  readonly paidThrough: Date | null;
  readonly cancelAtPeriodEnd: boolean;
  readonly graceStartedAt: Date | null;
  readonly graceEndsAt: Date | null;
  readonly everPaidAt: Date | null;
  readonly authorityUpdatedAt: Date;
  readonly reconciledAt: Date;
};

export type AccountTrialPeriod = {
  readonly startedAt: Date;
  readonly endsAt: Date;
};

const paidSubscriptionStatuses = new Set(["active", "canceled", "past_due", "paused", "unpaid"]);
const authorityEpoch = DateTime.toDateUtc(DateTime.makeUnsafe("1970-01-01T00:00:00.000Z"));

const latestDate = (dates: ReadonlyArray<Date | null | undefined>): Date =>
  dates.reduce<Date>(
    (latest, candidate) =>
      candidate !== null && candidate !== undefined && candidate > latest ? candidate : latest,
    authorityEpoch,
  );

export const billingAuthoritySnapshotFromPolar = (
  customerState: CustomerState,
  subscriptions: ReadonlyArray<Subscription>,
  configuration: {
    readonly paidBenefitId: string;
    readonly productIds: ReadonlyArray<string>;
  },
): BillingAuthoritySnapshot => {
  const matching = subscriptions.filter((subscription) =>
    configuration.productIds.includes(subscription.productId),
  );
  const updatedAt = latestDate([
    customerState.createdAt,
    customerState.modifiedAt,
    ...matching.flatMap(({ createdAt, modifiedAt }) => [createdAt, modifiedAt]),
  ]);
  const everPaid = matching.some(({ status }) => paidSubscriptionStatuses.has(status));
  const hasPaidBenefit = customerState.grantedBenefits.some(
    ({ benefitId }) => benefitId === configuration.paidBenefitId,
  );
  const activeSubscriptions = matching.filter(({ status }) => status === "active");
  if (hasPaidBenefit && activeSubscriptions.length > 0) {
    const paidThrough = activeSubscriptions.reduce<Date | null>(
      (latest, subscription) =>
        latest === null || subscription.currentPeriodEnd > latest
          ? subscription.currentPeriodEnd
          : latest,
      null,
    );
    if (paidThrough === null) {
      throw new Error("Polar returned an active subscription without a paid-through instant.");
    }
    return {
      kind: "PAID",
      paidThrough,
      cancelAtPeriodEnd: activeSubscriptions.every(({ cancelAtPeriodEnd }) => cancelAtPeriodEnd),
      updatedAt,
    };
  }

  const pastDue = matching
    .filter((subscription) => subscription.status === "past_due")
    .sort(
      (left, right) =>
        (right.pastDueAt ?? right.currentPeriodEnd).getTime() -
        (left.pastDueAt ?? left.currentPeriodEnd).getTime(),
    )[0];
  if (pastDue !== undefined) {
    return {
      kind: "PAST_DUE",
      pastDueAt: pastDue.pastDueAt ?? pastDue.currentPeriodEnd,
      updatedAt,
    };
  }

  return {
    kind: "NONE",
    everPaid,
    updatedAt,
  };
};

export class BillingProviderError extends Data.TaggedError("BillingProviderError")<{
  readonly cause: unknown;
  readonly message: string;
}> {}

export class BillingWebhookVerificationError extends Data.TaggedError(
  "BillingWebhookVerificationError",
)<{
  readonly cause: unknown;
  readonly message: string;
}> {}

export class BillingWebhookPayloadError extends Data.TaggedError("BillingWebhookPayloadError")<{
  readonly cause: unknown;
  readonly message: string;
}> {}

export class AccountBillingStateRepository extends Context.Service<
  AccountBillingStateRepository,
  {
    readonly find: (workosUserId: string) => Effect.Effect<AccountBillingState | null>;
    readonly save: (state: AccountBillingState) => Effect.Effect<AccountBillingState>;
  }
>()("@plakk/backend/billing/AccountBilling/AccountBillingStateRepository") {
  static readonly layer = Layer.effect(
    AccountBillingStateRepository,
    Effect.gen(function* () {
      const { db } = yield* Drizzle;

      const find = Effect.fn("AccountBillingStateRepository.find")(function* (
        workosUserId: string,
      ) {
        const [state] = yield* db
          .select()
          .from(accountBillingStates)
          .where(eq(accountBillingStates.workosUserId, workosUserId))
          .limit(1)
          .pipe(Effect.orDie);
        if (state === undefined) return null;
        return {
          workosUserId: state.workosUserId,
          authorityStatus: state.authorityStatus,
          paidThrough: state.paidThrough,
          cancelAtPeriodEnd: state.cancelAtPeriodEnd,
          graceStartedAt: state.graceStartedAt,
          graceEndsAt: state.graceEndsAt,
          everPaidAt: state.everPaidAt,
          authorityUpdatedAt: state.authorityUpdatedAt,
          reconciledAt: state.reconciledAt,
        } satisfies AccountBillingState;
      });

      const save = Effect.fn("AccountBillingStateRepository.save")(function* (
        state: AccountBillingState,
      ) {
        const [saved] = yield* db
          .insert(accountBillingStates)
          .values(state)
          .onConflictDoUpdate({
            target: accountBillingStates.workosUserId,
            set: {
              authorityStatus: state.authorityStatus,
              paidThrough: state.paidThrough,
              cancelAtPeriodEnd: state.cancelAtPeriodEnd,
              graceStartedAt: state.graceStartedAt,
              graceEndsAt: state.graceEndsAt,
              everPaidAt: state.everPaidAt,
              authorityUpdatedAt: state.authorityUpdatedAt,
              reconciledAt: state.reconciledAt,
              updatedAt: state.reconciledAt,
            },
            setWhere: sql`${accountBillingStates.authorityUpdatedAt} <= ${state.authorityUpdatedAt}`,
          })
          .returning()
          .pipe(Effect.orDie);
        if (saved === undefined) {
          const authoritative = yield* find(state.workosUserId);
          if (authoritative !== null) return authoritative;
          return yield* Effect.die(new Error("The account billing state was not persisted."));
        }
        return {
          workosUserId: saved.workosUserId,
          authorityStatus: saved.authorityStatus,
          paidThrough: saved.paidThrough,
          cancelAtPeriodEnd: saved.cancelAtPeriodEnd,
          graceStartedAt: saved.graceStartedAt,
          graceEndsAt: saved.graceEndsAt,
          everPaidAt: saved.everPaidAt,
          authorityUpdatedAt: saved.authorityUpdatedAt,
          reconciledAt: saved.reconciledAt,
        } satisfies AccountBillingState;
      });

      return AccountBillingStateRepository.of({ find, save });
    }),
  );
}

export class BillingAuthority extends Context.Service<
  BillingAuthority,
  {
    readonly beginCheckout: (
      workosUserId: string,
      plan: BillingPlan,
    ) => Effect.Effect<{ readonly url: string }, BillingProviderError>;
    readonly openPortal: (
      workosUserId: string,
    ) => Effect.Effect<{ readonly url: string }, BillingProviderError>;
    readonly read: (
      workosUserId: string,
    ) => Effect.Effect<BillingAuthoritySnapshot, BillingProviderError>;
    readonly verifyWebhook: (
      body: string,
      headers: Readonly<Record<string, string>>,
    ) => Effect.Effect<string | null, BillingWebhookPayloadError | BillingWebhookVerificationError>;
  }
>()("@plakk/backend/billing/AccountBilling/BillingAuthority") {
  static readonly layer = Layer.effect(
    BillingAuthority,
    Effect.gen(function* () {
      const config = yield* Config.all({
        accessToken: Config.redacted("POLAR_ACCESS_TOKEN"),
        annualProductId: Config.nonEmptyString("POLAR_ANNUAL_PRODUCT_ID"),
        monthlyProductId: Config.nonEmptyString("POLAR_MONTHLY_PRODUCT_ID"),
        paidBenefitId: Config.nonEmptyString("POLAR_PAID_BENEFIT_ID"),
        server: Config.literals(["production", "sandbox"] as const, "POLAR_SERVER").pipe(
          Config.withDefault("sandbox" as const),
        ),
        webhookSecret: Config.redacted("POLAR_WEBHOOK_SECRET"),
        webOrigin: Config.nonEmptyString("PLAKK_WEB_ORIGIN"),
      }).pipe(Effect.orDie);
      const exactWebOrigin = parseExactHttpOrigin(config.webOrigin);
      if (exactWebOrigin === null) {
        return yield* Effect.die(
          new Error("PLAKK_WEB_ORIGIN must be an exact HTTP(S) origin for Polar returns."),
        );
      }
      const polar = new Polar({
        accessToken: Redacted.value(config.accessToken),
        server: config.server,
      });
      const productIdByPlan = {
        ANNUAL: config.annualProductId,
        MONTHLY: config.monthlyProductId,
      } as const satisfies Record<BillingPlan, string>;
      const productIds = [config.monthlyProductId, config.annualProductId];
      const billingUrl = new URL("/billing", exactWebOrigin);
      const checkoutReturnUrl = new URL(billingUrl);
      checkoutReturnUrl.searchParams.set("checkout", "returned");

      const readSubscriptions = async (workosUserId: string) => {
        const firstPage = await polar.subscriptions.list({
          externalCustomerId: workosUserId,
          limit: 100,
          productId: productIds,
        });
        const subscriptions: Array<Subscription> = [];
        for await (const page of firstPage) subscriptions.push(...page.result.items);
        return subscriptions;
      };

      const read = Effect.fn("BillingAuthority.read")(function* (workosUserId: string) {
        return yield* Effect.tryPromise({
          try: async () => {
            let customerState: CustomerState;
            try {
              customerState = await polar.customers.getStateExternal({
                externalId: workosUserId,
              });
            } catch (cause) {
              if (cause instanceof ResourceNotFound) {
                return {
                  kind: "NONE",
                  everPaid: false,
                  updatedAt: authorityEpoch,
                } as const;
              }
              throw cause;
            }
            if (customerState.externalId !== workosUserId) {
              throw new Error("Polar returned a customer with a mismatched external identity.");
            }
            return billingAuthoritySnapshotFromPolar(
              customerState,
              await readSubscriptions(workosUserId),
              {
                paidBenefitId: config.paidBenefitId,
                productIds,
              },
            );
          },
          catch: (cause) =>
            new BillingProviderError({
              cause,
              message: "Polar account state is temporarily unavailable.",
            }),
        }).pipe(
          Effect.timeout(BILLING_PROVIDER_TIMEOUT),
          Effect.mapError(
            (cause) =>
              new BillingProviderError({
                cause,
                message: "Polar account state is temporarily unavailable.",
              }),
          ),
        );
      });

      const beginCheckout = Effect.fn("BillingAuthority.beginCheckout")(function* (
        workosUserId: string,
        plan: BillingPlan,
      ) {
        return yield* Effect.tryPromise({
          try: async () => {
            const checkout = await polar.checkouts.create({
              allowTrial: false,
              externalCustomerId: workosUserId,
              products: [productIdByPlan[plan]],
              returnUrl: billingUrl.toString(),
              successUrl: checkoutReturnUrl.toString(),
            });
            return { url: checkout.url };
          },
          catch: (cause) =>
            new BillingProviderError({
              cause,
              message: "Polar checkout is temporarily unavailable.",
            }),
        }).pipe(
          Effect.timeout(BILLING_PROVIDER_TIMEOUT),
          Effect.mapError(
            (cause) =>
              new BillingProviderError({
                cause,
                message: "Polar checkout is temporarily unavailable.",
              }),
          ),
        );
      });

      const openPortal = Effect.fn("BillingAuthority.openPortal")(function* (workosUserId: string) {
        return yield* Effect.tryPromise({
          try: async () => {
            const session = await polar.customerSessions.create({
              externalCustomerId: workosUserId,
              returnUrl: billingUrl.toString(),
            });
            return { url: session.customerPortalUrl };
          },
          catch: (cause) =>
            new BillingProviderError({
              cause,
              message: "Polar billing recovery is temporarily unavailable.",
            }),
        }).pipe(
          Effect.timeout(BILLING_PROVIDER_TIMEOUT),
          Effect.mapError(
            (cause) =>
              new BillingProviderError({
                cause,
                message: "Polar billing recovery is temporarily unavailable.",
              }),
          ),
        );
      });

      const verifyWebhook = Effect.fn("BillingAuthority.verifyWebhook")(function* (
        body: string,
        headers: Readonly<Record<string, string>>,
      ) {
        return yield* Effect.try({
          try: () => {
            const event = validateEvent(body, { ...headers }, Redacted.value(config.webhookSecret));
            if (event.type !== "customer.state_changed") return null;
            return event.data.externalId ?? null;
          },
          catch: (cause) =>
            cause instanceof PolarWebhookVerificationError
              ? new BillingWebhookVerificationError({
                  cause,
                  message: "Polar webhook signature verification failed.",
                })
              : new BillingWebhookPayloadError({
                  cause,
                  message: "Polar webhook payload validation failed.",
                }),
        });
      });

      return BillingAuthority.of({ beginCheckout, openPortal, read, verifyWebhook });
    }),
  );
}

const applyAuthority = (
  workosUserId: string,
  existing: AccountBillingState | null,
  authority: BillingAuthoritySnapshot,
  now: Date,
): AccountBillingState => {
  switch (authority.kind) {
    case "PAID":
      return {
        workosUserId,
        authorityStatus: "PAID",
        paidThrough: authority.paidThrough,
        cancelAtPeriodEnd: authority.cancelAtPeriodEnd,
        graceStartedAt: null,
        graceEndsAt: null,
        everPaidAt: existing?.everPaidAt ?? now,
        authorityUpdatedAt: authority.updatedAt,
        reconciledAt: now,
      };
    case "PAST_DUE": {
      const graceStartedAt = existing?.graceStartedAt ?? authority.pastDueAt;
      return {
        workosUserId,
        authorityStatus: "PAST_DUE",
        paidThrough: existing?.paidThrough ?? null,
        cancelAtPeriodEnd: existing?.cancelAtPeriodEnd ?? false,
        graceStartedAt,
        graceEndsAt:
          existing?.graceEndsAt ??
          DateTime.toDateUtc(
            DateTime.addDuration(DateTime.makeUnsafe(graceStartedAt), GRACE_DURATION_MILLIS),
          ),
        everPaidAt: existing?.everPaidAt ?? now,
        authorityUpdatedAt: authority.updatedAt,
        reconciledAt: now,
      };
    }
    case "NONE":
      return {
        workosUserId,
        authorityStatus: "NONE",
        paidThrough: existing?.paidThrough ?? null,
        cancelAtPeriodEnd: existing?.cancelAtPeriodEnd ?? false,
        graceStartedAt: existing?.graceStartedAt ?? null,
        graceEndsAt: existing?.graceEndsAt ?? null,
        everPaidAt: existing?.everPaidAt ?? (authority.everPaid ? now : null),
        authorityUpdatedAt: authority.updatedAt,
        reconciledAt: now,
      };
  }
};

export const entitlementFromBillingState = (
  trial: AccountTrialPeriod,
  billing: AccountBillingState | null,
  nowMillis: number,
): AccountAccessEntitlement => {
  if (
    billing?.graceEndsAt !== null &&
    billing?.graceEndsAt !== undefined &&
    nowMillis < billing.graceEndsAt.getTime()
  ) {
    return {
      status: "GRACE_ACTIVE",
      graceEndsAt: DateTime.makeUnsafe(billing.graceEndsAt),
    };
  }
  if (
    billing?.paidThrough !== null &&
    billing?.paidThrough !== undefined &&
    nowMillis < billing.paidThrough.getTime()
  ) {
    return {
      status: "PAID_ACTIVE",
      paidThrough: DateTime.makeUnsafe(billing.paidThrough),
      cancelAtPeriodEnd: billing.cancelAtPeriodEnd,
    };
  }
  if (billing?.everPaidAt !== null && billing?.everPaidAt !== undefined) {
    return { status: "BILLING_RESTRICTED" };
  }
  return nowMillis < trial.endsAt.getTime()
    ? {
        status: "TRIAL_ACTIVE",
        trialEndsAt: DateTime.makeUnsafe(trial.endsAt),
      }
    : { status: "BILLING_RESTRICTED" };
};

export class AccountBilling extends Context.Service<
  AccountBilling,
  {
    readonly beginCheckout: (
      workosUserId: string,
      plan: BillingPlan,
    ) => Effect.Effect<{ readonly url: string }, BillingProviderError>;
    readonly getEntitlement: (
      workosUserId: string,
      trial: AccountTrialPeriod,
    ) => Effect.Effect<AccountAccessEntitlement>;
    readonly handleWebhook: (
      body: string,
      headers: Readonly<Record<string, string>>,
    ) => Effect.Effect<
      void,
      BillingProviderError | BillingWebhookPayloadError | BillingWebhookVerificationError
    >;
    readonly openPortal: (
      workosUserId: string,
    ) => Effect.Effect<{ readonly url: string }, BillingProviderError>;
  }
>()("@plakk/backend/billing/AccountBilling") {
  static readonly layer = Layer.effect(
    AccountBilling,
    Effect.gen(function* () {
      const authority = yield* BillingAuthority;
      const repository = yield* AccountBillingStateRepository;
      type ReconciliationLockEntry = {
        readonly lock: Semaphore.Semaphore;
        users: number;
      };
      // This map serializes reconciliation within one backend process. The repository's
      // authorityUpdatedAt guard remains the cross-instance stale-write protection.
      const reconciliationLocks = new Map<string, ReconciliationLockEntry>();

      const reconciliationLock = (workosUserId: string) =>
        Effect.sync(() => {
          const existing = reconciliationLocks.get(workosUserId);
          if (existing !== undefined) {
            existing.users += 1;
            return existing;
          }
          const created = { lock: Semaphore.makeUnsafe(1), users: 1 };
          reconciliationLocks.set(workosUserId, created);
          return created;
        });

      const releaseReconciliationLock = (workosUserId: string, entry: ReconciliationLockEntry) =>
        Effect.sync(() => {
          entry.users -= 1;
          if (entry.users === 0 && reconciliationLocks.get(workosUserId) === entry) {
            reconciliationLocks.delete(workosUserId);
          }
        });

      const reconcile = Effect.fn("AccountBilling.reconcile")(function* (workosUserId: string) {
        const entry = yield* reconciliationLock(workosUserId);
        return yield* entry.lock
          .withPermit(
            Effect.gen(function* () {
              const existing = yield* repository.find(workosUserId);
              const snapshot = yield* authority.read(workosUserId);
              const now = DateTime.toDateUtc(yield* DateTime.now);
              return yield* repository.save(applyAuthority(workosUserId, existing, snapshot, now));
            }),
          )
          .pipe(Effect.ensuring(releaseReconciliationLock(workosUserId, entry)));
      });

      const getEntitlement = Effect.fn("AccountBilling.getEntitlement")(function* (
        workosUserId: string,
        trial: AccountTrialPeriod,
      ) {
        const now = DateTime.toDateUtc(yield* DateTime.now);
        const stored = yield* repository.find(workosUserId);
        const billing =
          stored !== null &&
          now.getTime() - stored.reconciledAt.getTime() < BILLING_RECONCILIATION_FRESH_MILLIS
            ? stored
            : yield* reconcile(workosUserId).pipe(
                Effect.catchTag("BillingProviderError", () => repository.find(workosUserId)),
              );
        return entitlementFromBillingState(trial, billing, now.getTime());
      });

      const handleWebhook = Effect.fn("AccountBilling.handleWebhook")(function* (
        body: string,
        headers: Readonly<Record<string, string>>,
      ) {
        const workosUserId = yield* authority.verifyWebhook(body, headers);
        if (workosUserId === null) return;
        yield* reconcile(workosUserId);
      });

      return AccountBilling.of({
        beginCheckout: authority.beginCheckout,
        getEntitlement,
        handleWebhook,
        openPortal: authority.openPortal,
      });
    }),
  );
}
