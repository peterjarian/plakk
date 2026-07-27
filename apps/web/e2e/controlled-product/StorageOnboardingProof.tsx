import type { User } from "@plakk/shared";
import type { AccountStatus, StorageProviderStatus } from "@plakk/shared/PlakkApi";
import * as DateTime from "effect/DateTime";
import { useCallback, useRef, useState } from "react";

import { HomeView } from "../../src/product/HomeView.tsx";
import { StorageOnboardingView } from "../../src/product/StorageOnboardingView.tsx";
import { accountNeedsStorageOnboarding } from "../../src/product/storage-onboarding.ts";

const unlinkedAccount: AccountStatus = {
  accessEntitlement: {
    status: "TRIAL_ACTIVE",
    trialEndsAt: DateTime.makeUnsafe("2026-08-10T10:15:30.000Z"),
  },
  blockedReasons: ["storage"],
  canSync: false,
  storageProvider: null,
};

const connectedAccount: AccountStatus = {
  ...unlinkedAccount,
  blockedReasons: [],
  canSync: true,
  storageProvider: "GOOGLE_DRIVE",
};

const connectedProvider: StorageProviderStatus = {
  storageProvider: "GOOGLE_DRIVE",
  status: "CONNECTED",
  externalDestinationUrl: "https://drive.example/folder",
};

const notConnectedProvider: StorageProviderStatus = {
  storageProvider: "GOOGLE_DRIVE",
  status: "NOT_CONNECTED",
  externalDestinationUrl: null,
};

const user: User = {
  id: "controlled-storage-user",
  email: "storage-proof@example.com",
  firstName: "Storage",
  lastName: "Proof",
  createdAt: "2026-07-27T00:00:00.000Z",
  updatedAt: "2026-07-27T00:00:00.000Z",
};

type StorageProofMode =
  | "first-run"
  | "confirming"
  | "return-unconfirmed"
  | "return-connected"
  | "return-desktop"
  | "temporary-failure"
  | "authorization-failure";

export function StorageOnboardingProof({ mode }: { readonly mode: StorageProofMode }) {
  const [continued, setContinued] = useState(false);
  const temporaryFailures = useRef(mode === "temporary-failure" ? 1 : 0);
  const authorizationFailures = useRef(mode === "authorization-failure" ? 1 : 0);
  const origin = mode === "return-desktop" ? "DESKTOP" : "WEB";
  const providerHint = [
    "confirming",
    "return-unconfirmed",
    "return-connected",
    "return-desktop",
    "authorization-failure",
  ].includes(mode)
    ? ("GOOGLE_DRIVE" as const)
    : null;
  const confirmationRequested = providerHint !== null;

  const read = useCallback(async () => {
    if (temporaryFailures.current > 0) {
      temporaryFailures.current -= 1;
      throw new Error("controlled temporary backend failure");
    }
    if (mode === "confirming") {
      await new Promise((resolve) => window.setTimeout(resolve, 750));
      return { account: unlinkedAccount, providerStatus: notConnectedProvider };
    }
    if (mode === "return-connected" || mode === "return-desktop") {
      return { account: connectedAccount, providerStatus: connectedProvider };
    }
    if (mode === "return-unconfirmed" || mode === "authorization-failure") {
      return { account: unlinkedAccount, providerStatus: notConnectedProvider };
    }
    return { account: unlinkedAccount, providerStatus: null };
  }, [mode]);

  const begin = useCallback(async () => {
    if (authorizationFailures.current > 0) {
      authorizationFailures.current -= 1;
      throw new Error("controlled provider cancellation");
    }
    return {
      url: "https://api.workos.com/data-integrations/google-drive/authorize-redirect",
    };
  }, []);

  const onContinueWeb = useCallback(async () => {
    history.replaceState(null, "", "/snippets");
    setContinued(true);
  }, []);

  if (continued) {
    return (
      <HomeView
        user={user}
        state={{
          account: connectedAccount,
          accountId: user.id,
          apiAvailability: "available",
          kind: "ready",
          liveConnection: "connected",
          localReadPerformance: "accelerated",
          snippets: [],
        }}
        onRetry={null}
        onSignOut={() => undefined}
        signOutError={null}
      />
    );
  }

  if (mode === "first-run" && !accountNeedsStorageOnboarding(unlinkedAccount)) {
    throw new Error("The controlled first-run account did not require storage onboarding.");
  }

  return (
    <StorageOnboardingView
      begin={begin}
      confirmationRequested={confirmationRequested}
      onContinueWeb={onContinueWeb}
      origin={origin}
      providerHint={providerHint}
      read={read}
    />
  );
}
