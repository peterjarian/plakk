import type { BillingReturnTarget, BillingStatus, CurrentUser } from "@plakk/shared/PlakkApi";
import { createPolar, errors, type Polar } from "@polar-sh/sdk/2026-04";
import * as Cause from "effect/Cause";
import * as Clock from "effect/Clock";
import * as Config from "effect/Config";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
import { Persistable, PersistedCache, Persistence } from "effect/unstable/persistence";

const CUSTOMER_ACCESS_SNAPSHOT_TTL = Duration.minutes(5);
const CHECKOUT_PENDING_TTL = Duration.minutes(30);
const CHECKOUT_REFRESH_WINDOW = Duration.seconds(30);
const CHECKOUT_REFRESH_THROTTLE_TTL = Duration.seconds(2);
const CUSTOMER_STATE_TIMEOUT = Duration.seconds(5);
const BILLING_SESSION_TIMEOUT = Duration.seconds(15);

const CheckoutProductIdsSchema = Config.Array(Schema.Trim.check(Schema.isNonEmpty())).pipe(
  Schema.check(Schema.isMinLength(2)),
  Schema.check(Schema.isUnique()),
);

export class PolarBillingError extends Schema.TaggedErrorClass<PolarBillingError>()(
  "PolarBillingError",
  {
    operation: Schema.String,
    message: Schema.String,
  },
) {}

export class BillingIdentityError extends Schema.TaggedErrorClass<BillingIdentityError>()(
  "BillingIdentityError",
  {
    message: Schema.String,
  },
) {}

export class PaymentRequiredError extends Schema.TaggedErrorClass<PaymentRequiredError>()(
  "PaymentRequiredError",
  {
    message: Schema.String,
  },
) {}

export class PolarCustomerStateError extends Schema.TaggedErrorClass<PolarCustomerStateError>()(
  "PolarCustomerStateError",
  {
    message: Schema.String,
  },
) {}

const CustomerAccessSnapshotSchema = Schema.Struct({
  active_subscriptions: Schema.Array(
    Schema.Struct({
      cancel_at_period_end: Schema.Boolean,
    }),
  ),
  granted_benefits: Schema.Array(
    Schema.Struct({
      benefit_id: Schema.String,
      benefit_type: Schema.String,
    }),
  ),
});

const CustomerAccessResultSchema = Schema.Union([
  Schema.Struct({ _tag: Schema.Literal("NotFound") }),
  Schema.Struct({
    _tag: Schema.Literal("Found"),
    snapshot: CustomerAccessSnapshotSchema,
  }),
]);

type CustomerAccessResult = typeof CustomerAccessResultSchema.Type;

class CustomerAccessSnapshotRequest extends Persistable.Class<{
  payload: { readonly externalCustomerId: string };
}>()("CustomerAccessSnapshotRequest", {
  primaryKey: ({ externalCustomerId }) => externalCustomerId,
  success: CustomerAccessResultSchema,
  error: Schema.Union([PolarBillingError, PolarCustomerStateError]),
}) {}

class CheckoutPendingRequest extends Persistable.Class<{
  payload: { readonly externalCustomerId: string };
}>()("CheckoutPendingRequest", {
  primaryKey: ({ externalCustomerId }) => externalCustomerId,
  success: Schema.Struct({
    refreshStartedAt: Schema.NullOr(Schema.Finite),
  }),
  error: Schema.Never,
}) {}

class CheckoutRefreshRequest extends Persistable.Class<{
  payload: { readonly externalCustomerId: string };
}>()("CheckoutRefreshRequest", {
  primaryKey: ({ externalCustomerId }) => externalCustomerId,
  success: Schema.Boolean,
  error: Schema.Never,
}) {}

const providerError = (operation: string, cause: unknown) =>
  new PolarBillingError({
    operation,
    message: cause instanceof Error ? cause.message : "Polar request failed.",
  });

const withProviderTimeout =
  (operation: string, duration: Duration.Input) =>
  <A>(effect: Effect.Effect<A, PolarBillingError>) =>
    effect.pipe(
      Effect.timeout(duration),
      Effect.mapError((error) =>
        Cause.isTimeoutError(error)
          ? providerError(operation, new Error(`Polar ${operation} timed out.`))
          : error,
      ),
    );

export class PolarBilling extends Context.Service<
  PolarBilling,
  {
    readonly getCustomerState: (
      externalCustomerId: string,
    ) => Effect.Effect<CustomerAccessResult, PolarBillingError | PolarCustomerStateError>;
    readonly createCheckout: (input: {
      readonly externalCustomerId: string;
      readonly email: string;
      readonly name?: string;
      readonly productIds: ReadonlyArray<string>;
      readonly successUrl: string;
      readonly returnUrl: string;
    }) => Effect.Effect<string, PolarBillingError>;
    readonly createPortalSession: (input: {
      readonly externalCustomerId: string;
      readonly returnUrl: string;
    }) => Effect.Effect<string, PolarBillingError>;
  }
>()("@plakk/backend/billing/PolarBilling") {
  static layer = Layer.effect(
    PolarBilling,
    Effect.gen(function* () {
      const accessToken = yield* Config.redacted("POLAR_ACCESS_TOKEN");
      const environment = yield* Config.literals(["sandbox", "production"], "POLAR_ENVIRONMENT");
      const polar = createPolar({ accessToken: Redacted.value(accessToken), environment });
      return makePolarBilling(polar);
    }),
  );
}

export const makePolarBilling = (polar: Polar): PolarBilling["Service"] =>
  PolarBilling.of({
    getCustomerState: (externalCustomerId) =>
      Effect.tryPromise({
        try: () => polar.customers.getStateExternal(externalCustomerId),
        catch: (cause) => cause,
      }).pipe(
        Effect.map((state) => ({ _tag: "Found" as const, state })),
        Effect.catchIf(
          (cause): cause is InstanceType<typeof errors.ResourceNotFound> =>
            cause instanceof errors.ResourceNotFound,
          () => Effect.succeed({ _tag: "NotFound" as const }),
        ),
        Effect.mapError((cause) => providerError("getCustomerState", cause)),
        withProviderTimeout("getCustomerState", CUSTOMER_STATE_TIMEOUT),
        Effect.flatMap((result) =>
          result._tag === "NotFound"
            ? Effect.succeed(result)
            : Schema.decodeUnknownEffect(CustomerAccessSnapshotSchema)(result.state).pipe(
                Effect.map(
                  (snapshot): CustomerAccessResult => ({
                    _tag: "Found",
                    snapshot,
                  }),
                ),
                Effect.mapError(
                  (error) =>
                    new PolarCustomerStateError({
                      message: `Polar returned an invalid Customer State: ${error.message}`,
                    }),
                ),
              ),
        ),
      ),
    createCheckout: (input) =>
      Effect.tryPromise({
        try: () =>
          polar.checkouts.create({
            products: [...input.productIds],
            external_customer_id: input.externalCustomerId,
            customer_email: input.email,
            ...(input.name === undefined ? {} : { customer_name: input.name }),
            success_url: input.successUrl,
            return_url: input.returnUrl,
          }),
        catch: (cause) => providerError("createCheckout", cause),
      }).pipe(
        withProviderTimeout("createCheckout", BILLING_SESSION_TIMEOUT),
        Effect.map((checkout) => checkout.url),
      ),
    createPortalSession: (input) =>
      Effect.tryPromise({
        try: () =>
          polar.customerSessions.create({
            external_customer_id: input.externalCustomerId,
            return_url: input.returnUrl,
          }),
        catch: (cause) => providerError("createPortalSession", cause),
      }).pipe(
        withProviderTimeout("createPortalSession", BILLING_SESSION_TIMEOUT),
        Effect.map((session) => session.customer_portal_url),
      ),
  });

type BillingFailure =
  | PolarBillingError
  | PolarCustomerStateError
  | BillingIdentityError
  | PaymentRequiredError
  | Persistence.PersistenceError
  | Schema.SchemaError;

export class Billing extends Context.Service<
  Billing,
  {
    readonly status: (user: CurrentUser["Service"]) => Effect.Effect<BillingStatus, BillingFailure>;
    readonly open: (
      user: CurrentUser["Service"],
      returnTarget: BillingReturnTarget,
    ) => Effect.Effect<string, BillingFailure>;
    readonly invalidateCustomerAccessSnapshot: (
      user: CurrentUser["Service"],
    ) => Effect.Effect<void, Persistence.PersistenceError>;
    readonly requireAccess: (user: CurrentUser["Service"]) => Effect.Effect<void, BillingFailure>;
  }
>()("@plakk/backend/billing/Billing") {
  static layer = Layer.effect(
    Billing,
    Effect.gen(function* () {
      const polar = yield* PolarBilling;
      const persistence = yield* Persistence.Persistence;
      const accessBenefitId = yield* Config.nonEmptyString("POLAR_ACCESS_BENEFIT_ID");
      const productIds = yield* Config.schema(CheckoutProductIdsSchema, "POLAR_PRODUCT_IDS");
      const environment = yield* Config.literals(["sandbox", "production"], "POLAR_ENVIRONMENT");
      const webOrigin = (yield* Config.url("PLAKK_WEB_ORIGIN")).origin;

      const customerAccessSnapshots = yield* PersistedCache.make(
        (request: CustomerAccessSnapshotRequest) =>
          polar.getCustomerState(request.externalCustomerId),
        {
          storeId: `plakk:polar:2026-04:${environment}:customer-access-snapshot`,
          timeToLive: (exit) =>
            Exit.isFailure(exit) ? Duration.zero : CUSTOMER_ACCESS_SNAPSHOT_TTL,
          // Keep Redis authoritative so invalidation is visible to every backend instance.
          inMemoryTTL: () => Duration.zero,
        },
      );
      const pendingStore = yield* persistence.make({
        storeId: `plakk:polar:${environment}:checkout-pending`,
        timeToLive: () => CHECKOUT_PENDING_TTL,
      });
      const refreshStore = yield* persistence.make({
        storeId: `plakk:polar:${environment}:checkout-refresh`,
        timeToLive: () => CHECKOUT_REFRESH_THROTTLE_TTL,
      });

      const customerAccessRequest = (userId: string) =>
        new CustomerAccessSnapshotRequest({ externalCustomerId: userId });
      const pendingRequest = (userId: string) =>
        new CheckoutPendingRequest({ externalCustomerId: userId });
      const refreshRequest = (userId: string) =>
        new CheckoutRefreshRequest({ externalCustomerId: userId });
      const armCustomerAccessRefresh = Effect.fn("Billing.armCustomerAccessRefresh")(function* (
        userId: string,
      ) {
        yield* pendingStore.set(pendingRequest(userId), Exit.succeed({ refreshStartedAt: null }));
        yield* refreshStore.remove(refreshRequest(userId));
        yield* customerAccessSnapshots.invalidate(customerAccessRequest(userId));
      });

      const readCustomerAccessSnapshot = Effect.fn("Billing.readCustomerAccessSnapshot")(function* (
        userId: string,
      ) {
        const pending = yield* pendingStore.get(pendingRequest(userId));
        if (pending !== undefined && Exit.isSuccess(pending)) {
          const pendingState = pending.value;
          const now = yield* Clock.currentTimeMillis;
          const refreshStartedAt = pendingState.refreshStartedAt ?? now;
          if (pendingState.refreshStartedAt === null) {
            yield* pendingStore.set(pendingRequest(userId), Exit.succeed({ refreshStartedAt }));
          }
          if (now - refreshStartedAt < Duration.toMillis(CHECKOUT_REFRESH_WINDOW)) {
            const recentlyRefreshed = yield* refreshStore.get(refreshRequest(userId));
            if (recentlyRefreshed === undefined) {
              yield* customerAccessSnapshots.invalidate(customerAccessRequest(userId));
              yield* refreshStore.set(refreshRequest(userId), Exit.succeed(true));
            }
          } else {
            yield* pendingStore.remove(pendingRequest(userId));
            yield* refreshStore.remove(refreshRequest(userId));
          }
        }
        return yield* customerAccessSnapshots.get(customerAccessRequest(userId));
      });

      const status = Effect.fn("Billing.status")(function* (user: CurrentUser["Service"]) {
        const now = yield* Clock.currentTimeMillis;
        const freePeriod =
          user.freeUntil !== undefined && DateTime.toEpochMillis(user.freeUntil) > now
            ? ({
                status: "FREE_PERIOD" as const,
                freeUntil: user.freeUntil,
              } satisfies BillingStatus)
            : undefined;
        const useFreePeriodDuringOutage = (
          error: PolarBillingError | Persistence.PersistenceError,
        ) =>
          freePeriod === undefined
            ? Effect.fail(error)
            : Effect.logWarning("Billing state is unavailable during a Free Period", {
                error,
                workosUserId: user.id,
              }).pipe(Effect.as(undefined));
        const result = yield* readCustomerAccessSnapshot(user.id).pipe(
          Effect.catchTags({
            PersistenceError: useFreePeriodDuringOutage,
            PolarBillingError: useFreePeriodDuringOutage,
          }),
        );
        if (result === undefined) return freePeriod ?? { status: "PAYMENT_REQUIRED" as const };
        if (result._tag === "Found") {
          const snapshot = result.snapshot;
          const hasAccess = snapshot.granted_benefits.some(
            (benefit) =>
              benefit.benefit_type === "feature_flag" && benefit.benefit_id === accessBenefitId,
          );
          if (hasAccess) {
            yield* pendingStore.remove(pendingRequest(user.id));
            yield* refreshStore.remove(refreshRequest(user.id));
            return {
              status: "SUBSCRIBED" as const,
              cancelAtPeriodEnd:
                snapshot.active_subscriptions.length > 0 &&
                snapshot.active_subscriptions.every(
                  (subscription) => subscription.cancel_at_period_end,
                ),
            };
          }
        }

        return freePeriod ?? { status: "PAYMENT_REQUIRED" as const };
      });

      const open = Effect.fn("Billing.open")(function* (
        user: CurrentUser["Service"],
        returnTarget: BillingReturnTarget,
      ) {
        const returnUrl =
          returnTarget === "DESKTOP" ? `${webOrigin}/billing/desktop-return` : webOrigin;
        const current = yield* status(user);
        if (current.status === "SUBSCRIBED") {
          return yield* polar.createPortalSession({
            externalCustomerId: user.id,
            returnUrl,
          });
        }
        if (typeof user.email !== "string" || user.email === "") {
          return yield* new BillingIdentityError({
            message: "The signed WorkOS token does not include an email address.",
          });
        }

        const url = yield* polar.createCheckout({
          externalCustomerId: user.id,
          email: user.email,
          ...(user.name === undefined ? {} : { name: user.name }),
          productIds,
          successUrl: returnTarget === "DESKTOP" ? returnUrl : `${webOrigin}/?billing=success`,
          returnUrl,
        });
        yield* armCustomerAccessRefresh(user.id);
        return url;
      });

      const invalidateCustomerAccessSnapshot = Effect.fn(
        "Billing.invalidateCustomerAccessSnapshot",
      )(function* (user: CurrentUser["Service"]) {
        yield* customerAccessSnapshots.invalidate(customerAccessRequest(user.id));
      });

      const requireAccess = Effect.fn("Billing.requireAccess")(function* (
        user: CurrentUser["Service"],
      ) {
        const current = yield* status(user);
        if (current.status === "PAYMENT_REQUIRED") {
          return yield* new PaymentRequiredError({
            message: "Your free access has ended. Subscribe to continue using Plakk.",
          });
        }
      });

      return Billing.of({ status, open, invalidateCustomerAccessSnapshot, requireAccess });
    }),
  );
}
