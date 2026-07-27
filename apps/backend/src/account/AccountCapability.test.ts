import {
  StorageCredentialsError,
  StorageNeedsReauthorizationError,
  StorageProvider,
} from "../storage/StorageProvider.ts";
import { RpcError } from "@plakk/shared/RpcError";
import { describe, expect, it, vi } from "vite-plus/test";
import { DateTime, Effect, Layer } from "effect";
import { TestClock } from "effect/testing";

import { AccountBilling, entitlementFromBillingState } from "../billing/AccountBilling.ts";
import {
  AccountCapability,
  AccountTrialRepository,
  TRIAL_DURATION_MILLIS,
  type AccountTrial,
} from "./AccountCapability.ts";
import { StorageLifecycle } from "../storage/StorageLifecycle.ts";

const storageLifecycleService = (
  overrides: Partial<StorageLifecycle["Service"]> = {},
): StorageLifecycle["Service"] =>
  StorageLifecycle.of({
    assertCommandsAllowed: () => Effect.void,
    beginAuthorization: () => Effect.succeed({ url: "https://workos.example/authorize" }),
    beginCleanup: (input) => Effect.succeed({ action: input.action, outcome: "COMPLETED" }),
    getManagementState: () =>
      Effect.succeed({
        affectedSnippetCount: 0,
        cleanup: null,
        connectionStatus: "CONNECTED",
        externalDestinationUrl: "https://drive.example/folder",
        storageProvider: "GOOGLE_DRIVE",
      }),
    getProviderStatus: (_, storageProvider) =>
      Effect.succeed({
        externalDestinationUrl: "https://drive.example/folder",
        status: "CONNECTED",
        storageProvider,
      }),
    retryCleanup: () => Effect.succeed({ action: "UNLINK", outcome: "COMPLETED" }),
    ...overrides,
  });

const trialStartMillis = Date.parse("2026-07-27T10:15:30.000Z");
const trialEndsMillis = trialStartMillis + TRIAL_DURATION_MILLIS;

const makeTrialRepository = () => {
  const trials = new Map<string, AccountTrial>();
  const getOrCreate = vi.fn((candidate: AccountTrial) =>
    Effect.sync(() => {
      const existing = trials.get(candidate.workosUserId);
      if (existing !== undefined) return existing;
      trials.set(candidate.workosUserId, candidate);
      return candidate;
    }),
  );
  const find = vi.fn((workosUserId: string) => Effect.sync(() => trials.get(workosUserId) ?? null));
  return {
    layer: Layer.succeed(AccountTrialRepository, AccountTrialRepository.of({ find, getOrCreate })),
    trials,
  };
};

const storageService = (
  overrides: Partial<StorageProvider["Service"]> = {},
): StorageProvider["Service"] =>
  StorageProvider.of({
    beginAuthorization: () => Effect.succeed({ url: "https://workos.example/authorize" }),
    deleteObject: () => Effect.void,
    disconnect: () => Effect.void,
    downloadObject: () => Effect.succeed(new Uint8Array()),
    ensureConnected: () => Effect.void,
    getDestinationUrl: () => Effect.succeed("https://drive.example/folder"),
    getLinkedProvider: () => Effect.succeed("GOOGLE_DRIVE"),
    getStatus: () =>
      Effect.succeed({
        externalDestinationUrl: "https://drive.example/folder",
        status: "CONNECTED",
        storageProvider: "GOOGLE_DRIVE",
      }),
    getDownloadTarget: () => Effect.succeed({ url: "https://download.example", headers: [] }),
    getDownloadUrl: () => Effect.succeed("https://download.example"),
    prepareUpload: () =>
      Effect.succeed({
        storageProvider: "GOOGLE_DRIVE",
        storageObjectId: null,
        upload: {
          method: "PUT",
          url: "https://upload.example",
          headers: [],
          strategy: { type: "single_request" },
        },
        expiresAt: null,
      }),
    ...overrides,
  });

const billingService = (
  overrides: Partial<AccountBilling["Service"]> = {},
): AccountBilling["Service"] =>
  AccountBilling.of({
    beginCheckout: () => Effect.succeed({ url: "https://checkout.example" }),
    getEntitlement: (_workosUserId, trial) =>
      DateTime.now.pipe(
        Effect.map((now) => entitlementFromBillingState(trial, null, DateTime.toEpochMillis(now))),
      ),
    handleWebhook: () => Effect.void,
    openPortal: () => Effect.succeed({ url: "https://portal.example" }),
    ...overrides,
  });

const runCapability = <A, E>(
  use: (capability: AccountCapability["Service"]) => Effect.Effect<A, E>,
  options?: {
    readonly repository?: ReturnType<typeof makeTrialRepository>;
    readonly storage?: StorageProvider["Service"];
    readonly billing?: AccountBilling["Service"];
    readonly storageLifecycle?: StorageLifecycle["Service"];
  },
) => {
  const repository = options?.repository ?? makeTrialRepository();
  const capabilityLayer = AccountCapability.layer.pipe(
    Layer.provide(repository.layer),
    Layer.provide(Layer.succeed(StorageProvider, options?.storage ?? storageService())),
    Layer.provide(Layer.succeed(AccountBilling, options?.billing ?? billingService())),
    Layer.provide(
      Layer.succeed(StorageLifecycle, options?.storageLifecycle ?? storageLifecycleService()),
    ),
  );
  return Effect.runPromise(
    Effect.gen(function* () {
      const capability = yield* AccountCapability;
      return yield* use(capability);
    }).pipe(Effect.provide(Layer.merge(capabilityLayer, TestClock.layer())), Effect.orDie),
  );
};

describe("account trial capability", () => {
  it("consults billing authority on the first status read after creating the trial", async () => {
    const getEntitlement = vi.fn(() =>
      Effect.succeed({
        status: "BILLING_RESTRICTED" as const,
      }),
    );

    const status = await runCapability(
      (capability) =>
        Effect.gen(function* () {
          yield* TestClock.setTime(trialStartMillis);
          return yield* capability.getStatus("user-1");
        }),
      { billing: billingService({ getEntitlement }) },
    );

    expect(getEntitlement).toHaveBeenCalledTimes(1);
    expect(getEntitlement).toHaveBeenCalledWith(
      "user-1",
      expect.objectContaining({ workosUserId: "user-1" }),
    );
    expect(status.accessEntitlement).toEqual({ status: "BILLING_RESTRICTED" });
  });

  it("creates one immutable 14-day trial under concurrent first sign-ins", async () => {
    const repository = makeTrialRepository();

    const entitlements = await runCapability(
      (capability) =>
        Effect.gen(function* () {
          yield* TestClock.setTime(trialStartMillis);
          return yield* Effect.all(
            Array.from({ length: 24 }, () => capability.startTrial("user-1")),
            { concurrency: "unbounded" },
          );
        }),
      { repository },
    );

    expect(repository.trials.size).toBe(1);
    expect(repository.trials.get("user-1")?.startedAt.toISOString()).toBe(
      "2026-07-27T10:15:30.000Z",
    );
    expect(
      new Set(
        entitlements.map((entitlement) =>
          entitlement.status === "TRIAL_ACTIVE"
            ? DateTime.formatIso(entitlement.trialEndsAt)
            : entitlement.status,
        ),
      ),
    ).toEqual(new Set(["2026-08-10T10:15:30.000Z"]));
  });

  it("never restarts a trial from a later browser or client", async () => {
    const repository = makeTrialRepository();

    const [first, later] = await runCapability(
      (capability) =>
        Effect.gen(function* () {
          yield* TestClock.setTime(trialStartMillis);
          const first = yield* capability.startTrial("user-1");
          yield* TestClock.adjust("5 days");
          const later = yield* capability.startTrial("user-1");
          return [first, later] as const;
        }),
      { repository },
    );

    expect(later).toEqual(first);
    expect(repository.trials.size).toBe(1);
  });

  it("permits the instant before expiry and restricts the exact 14-day boundary", async () => {
    const statuses = await runCapability((capability) =>
      Effect.gen(function* () {
        yield* TestClock.setTime(trialStartMillis);
        yield* capability.startTrial("user-1");
        yield* TestClock.setTime(trialEndsMillis - 1);
        const beforeExpiry = yield* capability.getStatus("user-1");
        yield* TestClock.setTime(trialEndsMillis);
        const atExpiry = yield* capability.getStatus("user-1");
        return { atExpiry, beforeExpiry };
      }),
    );

    expect(statuses.beforeExpiry.accessEntitlement.status).toBe("TRIAL_ACTIVE");
    expect(statuses.beforeExpiry.blockedReasons).toEqual([]);
    expect(statuses.atExpiry.accessEntitlement.status).toBe("BILLING_RESTRICTED");
    expect(statuses.atExpiry.blockedReasons).toEqual(["billing"]);
  });

  it("reports billing and storage blockers independently and together", async () => {
    const repository = makeTrialRepository();
    const noStorage = storageService({ getLinkedProvider: () => Effect.succeed(null) });

    const active = await runCapability(
      (capability) =>
        Effect.gen(function* () {
          yield* TestClock.setTime(trialStartMillis);
          yield* capability.startTrial("user-1");
          return yield* capability.getStatus("user-1");
        }),
      { repository, storage: noStorage },
    );
    const expired = await runCapability(
      (capability) =>
        Effect.gen(function* () {
          yield* TestClock.setTime(trialEndsMillis);
          return yield* capability.getStatus("user-1");
        }),
      { repository, storage: noStorage },
    );

    expect(active.blockedReasons).toEqual(["storage"]);
    expect(expired.blockedReasons).toEqual(["billing", "storage"]);
  });

  it("preserves storage restriction when backend-confirmed paid recovery clears billing", async () => {
    const repository = makeTrialRepository();
    const noStorage = storageService({ getLinkedProvider: () => Effect.succeed(null) });
    const billing = billingService({
      getEntitlement: () =>
        Effect.succeed({
          status: "PAID_ACTIVE",
          paidThrough: DateTime.makeUnsafe("2026-09-10T00:00:00.000Z"),
          cancelAtPeriodEnd: false,
        }),
    });

    const recovered = await runCapability(
      (capability) =>
        Effect.gen(function* () {
          yield* TestClock.setTime(trialStartMillis);
          yield* capability.startTrial("user-1");
          return yield* capability.getStatus("user-1");
        }),
      { billing, repository, storage: noStorage },
    );

    expect(recovered.accessEntitlement.status).toBe("PAID_ACTIVE");
    expect(recovered.blockedReasons).toEqual(["storage"]);
    expect(recovered.canSync).toBe(false);
  });

  it("keeps entitlement status available when linked-storage lookup fails", async () => {
    const status = await runCapability(
      (capability) =>
        Effect.gen(function* () {
          yield* TestClock.setTime(trialStartMillis);
          return yield* capability.getStatus("user-1");
        }),
      {
        storage: storageService({
          getLinkedProvider: () =>
            Effect.fail(
              new StorageCredentialsError({
                cause: null,
                message: "storage credentials unavailable",
              }),
            ),
        }),
      },
    );

    expect(status.accessEntitlement.status).toBe("TRIAL_ACTIVE");
    expect(status.storageProvider).toBeNull();
    expect(status.blockedReasons).toEqual(["storage"]);
  });

  it("preserves the linked provider when its connection assessment fails", async () => {
    const status = await runCapability(
      (capability) =>
        Effect.gen(function* () {
          yield* TestClock.setTime(trialStartMillis);
          return yield* capability.getStatus("user-1");
        }),
      {
        storage: storageService({
          ensureConnected: () =>
            Effect.fail(
              new StorageCredentialsError({
                cause: null,
                message: "storage credentials unavailable",
              }),
            ),
        }),
      },
    );

    expect(status.accessEntitlement.status).toBe("TRIAL_ACTIVE");
    expect(status.storageProvider).toBe("GOOGLE_DRIVE");
    expect(status.blockedReasons).toEqual(["storage"]);
  });

  it("authorizes only active accounts using their usable linked provider", async () => {
    const repository = makeTrialRepository();
    const ensureConnected = vi.fn(() => Effect.void);
    const storage = storageService({ ensureConnected });

    await runCapability(
      (capability) =>
        Effect.gen(function* () {
          yield* TestClock.setTime(trialStartMillis);
          yield* capability.startTrial("user-1");
          yield* capability.authorizeProductCommand("user-1", "GOOGLE_DRIVE");
        }),
      { repository, storage },
    );

    expect(ensureConnected).toHaveBeenCalledWith({
      storageProvider: "GOOGLE_DRIVE",
      workosUserId: "user-1",
    });
  });

  it("rejects product commands at expiry before touching storage", async () => {
    const repository = makeTrialRepository();
    const ensureConnected = vi.fn(() => Effect.void);
    const storage = storageService({ ensureConnected });

    const exit = await runCapability(
      (capability) =>
        Effect.gen(function* () {
          yield* TestClock.setTime(trialStartMillis);
          yield* capability.startTrial("user-1");
          yield* TestClock.setTime(trialEndsMillis);
          return yield* capability
            .authorizeProductCommand("user-1", "GOOGLE_DRIVE")
            .pipe(Effect.result);
        }),
      { repository, storage },
    );

    expect(exit).toMatchObject({
      _tag: "Failure",
      failure: { code: "FORBIDDEN" },
    });
    expect(ensureConnected).not.toHaveBeenCalled();
  });

  it("marks storage unavailable and rejects late commands while cleanup is active", async () => {
    const repository = makeTrialRepository();
    const ensureConnected = vi.fn(() => Effect.void);
    const storage = storageService({ ensureConnected });
    const storageLifecycle = storageLifecycleService({
      assertCommandsAllowed: () =>
        Effect.fail(
          new RpcError({
            code: "CONFLICT",
            message: "Storage cleanup is in progress.",
          }),
        ),
    });

    const result = await runCapability(
      (capability) =>
        Effect.gen(function* () {
          yield* TestClock.setTime(trialStartMillis);
          yield* capability.startTrial("user-1");
          const status = yield* capability.getStatus("user-1");
          const command = yield* capability
            .authorizeProductCommand("user-1", "GOOGLE_DRIVE")
            .pipe(Effect.result);
          const deletion = yield* capability.authorizeSnippetDeletion("user-1").pipe(Effect.result);
          return { command, deletion, status };
        }),
      { repository, storage, storageLifecycle },
    );

    expect(result.status.storageProvider).toBe("GOOGLE_DRIVE");
    expect(result.status.blockedReasons).toContain("storage");
    expect(result.command).toMatchObject({
      _tag: "Failure",
      failure: { code: "CONFLICT" },
    });
    expect(result.deletion).toMatchObject({
      _tag: "Failure",
      failure: { code: "CONFLICT" },
    });
    expect(ensureConnected).not.toHaveBeenCalled();
  });

  it("keeps Snippet deletion available while the linked provider needs reauthorization", async () => {
    const ensureConnected = vi.fn(() =>
      Effect.fail(
        new StorageNeedsReauthorizationError({
          message: "Reconnect storage before using provider content.",
        }),
      ),
    );
    const result = await runCapability(
      (capability) => capability.authorizeSnippetDeletion("user-1").pipe(Effect.result),
      {
        storage: storageService({ ensureConnected }),
      },
    );

    expect(result).toMatchObject({ _tag: "Success" });
    expect(ensureConnected).not.toHaveBeenCalled();
  });

  it("keeps Snippet deletion available when no provider is linked", async () => {
    const getLinkedProvider = vi.fn(() => Effect.succeed(null));
    const result = await runCapability(
      (capability) => capability.authorizeSnippetDeletion("user-1").pipe(Effect.result),
      {
        storage: storageService({ getLinkedProvider }),
      },
    );

    expect(result).toMatchObject({ _tag: "Success" });
    expect(getLinkedProvider).not.toHaveBeenCalled();
  });
});
