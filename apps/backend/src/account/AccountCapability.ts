import { Drizzle, eq } from "@plakk/db";
import { accountTrials } from "@plakk/db/schema";
import type { StorageProvider as StorageProviderName } from "@plakk/shared";
import type {
  AccountAccessEntitlement,
  AccountBlockedReason,
  AccountStatus,
} from "@plakk/shared/PlakkApi";
import { RpcError } from "@plakk/shared/RpcError";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import { AccountBilling } from "../billing/AccountBilling.ts";
import {
  StorageCredentialsError,
  StorageNeedsReauthorizationError,
  StorageNotConnectedError,
  StorageProvider,
} from "../storage/StorageProvider.ts";

export const TRIAL_DURATION_MILLIS = 14 * 24 * 60 * 60 * 1_000;

export type AccountTrial = {
  readonly workosUserId: string;
  readonly startedAt: Date;
  readonly endsAt: Date;
};

export class AccountTrialRepository extends Context.Service<
  AccountTrialRepository,
  {
    readonly find: (workosUserId: string) => Effect.Effect<AccountTrial | null>;
    readonly getOrCreate: (candidate: AccountTrial) => Effect.Effect<AccountTrial>;
  }
>()("@plakk/backend/account/AccountCapability/AccountTrialRepository") {
  static readonly layer = Layer.effect(
    AccountTrialRepository,
    Effect.gen(function* () {
      const { db } = yield* Drizzle;

      const find = Effect.fn("AccountTrialRepository.find")(function* (workosUserId: string) {
        const [trial] = yield* db
          .select()
          .from(accountTrials)
          .where(eq(accountTrials.workosUserId, workosUserId))
          .limit(1)
          .pipe(Effect.orDie);
        return trial ?? null;
      });

      const getOrCreate = Effect.fn("AccountTrialRepository.getOrCreate")(function* (
        candidate: AccountTrial,
      ) {
        const [created] = yield* db
          .insert(accountTrials)
          .values(candidate)
          .onConflictDoNothing()
          .returning()
          .pipe(Effect.orDie);
        if (created !== undefined) return created;

        const existing = yield* find(candidate.workosUserId);
        if (existing !== null) return existing;
        return yield* Effect.die(
          new Error("The account trial conflict completed without a persisted trial."),
        );
      });

      return AccountTrialRepository.of({ find, getOrCreate });
    }),
  );
}

type StorageAssessment = {
  readonly storageProvider: StorageProviderName | null;
  readonly usable: boolean;
};

const internalStorageError = (message: string) =>
  new RpcError({ code: "INTERNAL_SERVER_ERROR", message });

const forbiddenStorageError = (message: string) => new RpcError({ code: "FORBIDDEN", message });

const mapStorageReadError = (error: StorageCredentialsError) => internalStorageError(error.message);

const mapStorageAuthorizationError = (
  error: StorageCredentialsError | StorageNeedsReauthorizationError | StorageNotConnectedError,
) =>
  error._tag === "StorageCredentialsError"
    ? internalStorageError(error.message)
    : forbiddenStorageError(error.message);

const entitlementFromTrial = (trial: AccountTrial, nowMillis: number): AccountAccessEntitlement =>
  nowMillis < trial.endsAt.getTime()
    ? {
        status: "TRIAL_ACTIVE",
        trialEndsAt: DateTime.makeUnsafe(trial.endsAt),
      }
    : { status: "BILLING_RESTRICTED" };

export class AccountCapability extends Context.Service<
  AccountCapability,
  {
    readonly authorizeProductCommand: (
      workosUserId: string,
      storageProvider: StorageProviderName,
    ) => Effect.Effect<void, RpcError>;
    readonly getStatus: (workosUserId: string) => Effect.Effect<AccountStatus, RpcError>;
    readonly startTrial: (workosUserId: string) => Effect.Effect<AccountAccessEntitlement>;
  }
>()("@plakk/backend/account/AccountCapability") {
  static readonly layer = Layer.effect(
    AccountCapability,
    Effect.gen(function* () {
      const trials = yield* AccountTrialRepository;
      const billing = yield* AccountBilling;
      const storage = yield* StorageProvider;

      const ensureTrial = Effect.fn("AccountCapability.ensureTrial")(function* (
        workosUserId: string,
      ) {
        const now = yield* DateTime.now;
        return yield* trials.getOrCreate({
          workosUserId,
          startedAt: DateTime.toDateUtc(now),
          endsAt: DateTime.toDateUtc(DateTime.addDuration(now, TRIAL_DURATION_MILLIS)),
        });
      });

      const startTrial = Effect.fn("AccountCapability.startTrial")(function* (
        workosUserId: string,
      ) {
        const trial = yield* ensureTrial(workosUserId);
        return entitlementFromTrial(trial, DateTime.toEpochMillis(yield* DateTime.now));
      });

      const getEntitlement = Effect.fn("AccountCapability.getEntitlement")(function* (
        workosUserId: string,
      ) {
        const trial = (yield* trials.find(workosUserId)) ?? (yield* ensureTrial(workosUserId));
        return yield* billing.getEntitlement(workosUserId, trial);
      });

      const assessStorage = Effect.fn("AccountCapability.assessStorage")(function* (
        workosUserId: string,
      ): Effect.fn.Return<StorageAssessment> {
        const storageProvider = yield* storage
          .getLinkedProvider(workosUserId)
          .pipe(Effect.orElseSucceed(() => null));
        if (storageProvider === null) return { storageProvider, usable: false };

        const usable = yield* storage.ensureConnected({ storageProvider, workosUserId }).pipe(
          Effect.as(true),
          Effect.catchTags({
            StorageCredentialsError: () => Effect.succeed(false),
            StorageNeedsReauthorizationError: () => Effect.succeed(false),
            StorageNotConnectedError: () => Effect.succeed(false),
          }),
        );
        return { storageProvider, usable };
      });

      const getStatus = Effect.fn("AccountCapability.getStatus")(function* (workosUserId: string) {
        const [accessEntitlement, storageAssessment] = yield* Effect.all(
          [getEntitlement(workosUserId), assessStorage(workosUserId)],
          { concurrency: "unbounded" },
        );
        const blockedReasons: Array<AccountBlockedReason> = [];
        if (accessEntitlement.status === "BILLING_RESTRICTED") {
          blockedReasons.push("billing");
        }
        if (!storageAssessment.usable) blockedReasons.push("storage");

        return {
          accessEntitlement,
          blockedReasons,
          canSync: blockedReasons.length === 0,
          storageProvider: storageAssessment.storageProvider,
        } satisfies AccountStatus;
      });

      const authorizeProductCommand = Effect.fn("AccountCapability.authorizeProductCommand")(
        function* (workosUserId: string, storageProvider: StorageProviderName) {
          const entitlement = yield* getEntitlement(workosUserId);
          if (entitlement.status === "BILLING_RESTRICTED") {
            return yield* new RpcError({
              code: "FORBIDDEN",
              message: "Restore billing access to use this action.",
            });
          }

          const linkedProvider = yield* storage
            .getLinkedProvider(workosUserId)
            .pipe(Effect.mapError(mapStorageReadError));
          if (linkedProvider !== storageProvider) {
            return yield* forbiddenStorageError(
              "Connect the selected storage provider to continue.",
            );
          }
          yield* storage
            .ensureConnected({ storageProvider, workosUserId })
            .pipe(Effect.mapError(mapStorageAuthorizationError));
        },
      );

      return AccountCapability.of({
        authorizeProductCommand,
        getStatus,
        startTrial,
      });
    }),
  );
}
