import { CurrentUser } from "@plakk/shared/PlakkApi";
import { describe, expect, it, vi } from "vite-plus/test";
import { Effect } from "effect";

import { AccountCapability } from "../account/AccountCapability.ts";
import { runAuthenticatedRpc } from "./AuthMiddlewareLive.ts";

const activeTrial = {
  status: "TRIAL_ACTIVE" as const,
  trialStartedAt: "2026-07-27T10:15:30.000Z",
  trialEndsAt: "2026-08-10T10:15:30.000Z",
};

const capabilityService = (
  startTrial: AccountCapability["Service"]["startTrial"],
): AccountCapability["Service"] =>
  AccountCapability.of({
    authorizeProductCommand: () => Effect.void,
    getStatus: () =>
      Effect.succeed({
        accessEntitlement: activeTrial,
        blockedReasons: [],
        canSync: true,
        storageProvider: "GOOGLE_DRIVE",
      }),
    startTrial,
  });

describe("backend authentication", () => {
  it("starts the account trial after verifying the WorkOS identity and before the RPC runs", async () => {
    const events: Array<string> = [];
    const startTrial = vi.fn((workosUserId: string) =>
      Effect.sync(() => {
        events.push(`trial:${workosUserId}`);
        return activeTrial;
      }),
    );
    const verify = (accessToken: string) =>
      Effect.sync(() => {
        events.push(`verified:${accessToken}`);
        return { id: "user-1" };
      });

    const userId = await Effect.runPromise(
      runAuthenticatedRpc(
        CurrentUser.pipe(
          Effect.tap(() =>
            Effect.sync(() => {
              events.push("rpc");
            }),
          ),
          Effect.map(({ id }) => id),
        ),
        "Bearer workos-token",
        verify,
        capabilityService(startTrial),
      ),
    );

    expect(userId).toBe("user-1");
    expect(events).toEqual(["verified:workos-token", "trial:user-1", "rpc"]);
  });

  it("does not create a trial when bearer authentication is absent", async () => {
    const verify = vi.fn(() => Effect.succeed({ id: "user-1" }));
    const startTrial = vi.fn(() => Effect.succeed(activeTrial));

    const result = await Effect.runPromise(
      runAuthenticatedRpc(Effect.void, undefined, verify, capabilityService(startTrial)).pipe(
        Effect.result,
      ),
    );

    expect(result).toMatchObject({
      _tag: "Failure",
      failure: { code: "UNAUTHENTICATED" },
    });
    expect(verify).not.toHaveBeenCalled();
    expect(startTrial).not.toHaveBeenCalled();
  });
});
