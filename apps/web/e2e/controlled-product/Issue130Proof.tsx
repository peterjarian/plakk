import type { User } from "@plakk/shared";
import type { AccountStatus, ApiSnippet } from "@plakk/shared/PlakkApi";
import * as DateTime from "effect/DateTime";
import { useState } from "react";

import { HomeView } from "../../src/product/HomeView.tsx";
import { SettingsView } from "../../src/product/SettingsView.tsx";
import { useWebAppearance, WebAppearanceProvider } from "../../src/product/web-appearance.tsx";

export type Issue130Mode = "billing" | "both" | "normal" | "storage";

const user: User = {
  id: "issue-130-user",
  email: "restricted@example.com",
  firstName: "Restricted",
  lastName: "Reader",
  createdAt: "2026-07-27T00:00:00.000Z",
  updatedAt: "2026-07-27T00:00:00.000Z",
};

const snippet = (id: string, fileName: string, byteSize: number): ApiSnippet => ({
  id,
  fileName,
  byteSize,
  storageProvider: "GOOGLE_DRIVE",
  storageObjectId: `object-${id}`,
  createdAt: "2026-07-27T10:00:00.000Z",
  updatedAt: "2026-07-27T10:00:00.000Z",
});

const initialSnippets = [
  snippet("20d1e2f3-a456-4890-8abc-def012345678", "Clipboard text.txt", 21),
  snippet("21d1e2f3-a456-4890-8abc-def012345678", "External link.txt", 33),
  snippet("22d1e2f3-a456-4890-8abc-def012345678", "Named download.pdf", 4096),
  snippet("23d1e2f3-a456-4890-8abc-def012345678", "Retained photo.png", 1024),
] as const;

const blockedReasonsFor = (mode: Issue130Mode): AccountStatus["blockedReasons"] =>
  mode === "both"
    ? ["billing", "storage"]
    : mode === "billing"
      ? ["billing"]
      : mode === "storage"
        ? ["storage"]
        : [];

const accountFor = (mode: Issue130Mode): AccountStatus => {
  const blockedReasons = blockedReasonsFor(mode);
  return {
    accessEntitlement: blockedReasons.includes("billing")
      ? { status: "BILLING_RESTRICTED" }
      : {
          status: "TRIAL_ACTIVE",
          trialEndsAt: DateTime.makeUnsafe("2026-08-10T10:15:30.000Z"),
        },
    blockedReasons,
    canSync: blockedReasons.length === 0,
    storageProvider: "GOOGLE_DRIVE",
  };
};

const recoveredPaidEntitlement = {
  status: "PAID_ACTIVE" as const,
  paidThrough: DateTime.makeUnsafe("2026-09-20T12:30:00.000Z"),
  cancelAtPeriodEnd: false,
};

function Issue130ProofContent({ mode }: Readonly<{ mode: Issue130Mode }>) {
  const appearance = useWebAppearance();
  const [screen, setScreen] = useState<"home" | "settings">("home");
  const [account, setAccount] = useState(() => accountFor(mode));
  const [snippets, setSnippets] = useState<ReadonlyArray<ApiSnippet>>(initialSnippets);

  const recordRecovery = (kind: "billing" | "storage") => {
    const current = document.documentElement.dataset.recoveryOrder;
    document.documentElement.dataset.recoveryOrder =
      current === undefined ? kind : `${current},${kind}`;
  };
  const recoverBilling = () => {
    recordRecovery("billing");
    setAccount((current) => {
      const blockedReasons = current.blockedReasons.filter((reason) => reason !== "billing");
      return {
        ...current,
        accessEntitlement: recoveredPaidEntitlement,
        blockedReasons,
        canSync: blockedReasons.length === 0,
      };
    });
  };
  const recoverStorage = () => {
    recordRecovery("storage");
    setAccount((current) => {
      const blockedReasons = current.blockedReasons.filter((reason) => reason !== "storage");
      return { ...current, blockedReasons, canSync: blockedReasons.length === 0 };
    });
  };
  const state = {
    account,
    accountId: user.id,
    apiAvailability: "available" as const,
    kind: "ready" as const,
    liveConnection: "connected" as const,
    localReadPerformance: "accelerated" as const,
    snippets: snippets.map((target) => ({ kind: "PUBLISHED" as const, snippet: target })),
  };

  if (screen === "settings") {
    return (
      <SettingsView
        appearance={appearance.preference}
        onAppearanceChange={appearance.setPreference}
        onBack={() => setScreen("home")}
        onBilling={recoverBilling}
        onSignOut={() => {
          document.documentElement.dataset.signOutRequested = "true";
        }}
        onStorage={recoverStorage}
        state={state}
        user={user}
      />
    );
  }

  return (
    <HomeView
      user={user}
      state={state}
      onRetry={() => undefined}
      onSignOut={() => {
        document.documentElement.dataset.signOutRequested = "true";
      }}
      signOutError={null}
      onAddFiles={() => {
        document.documentElement.dataset.addRequested = "file";
      }}
      onAddText={() => {
        document.documentElement.dataset.addRequested = "text";
      }}
      onDismissUpload={() => undefined}
      onBilling={recoverBilling}
      onSettings={() => setScreen("settings")}
      onStorageReconnect={recoverStorage}
      snippetActions={{
        copy: async (target) => {
          document.documentElement.dataset.copyRequested = target.id;
          return { kind: "COPIED" };
        },
        delete: async (id) => {
          document.documentElement.dataset.deleteRequested = id;
          setSnippets((current) => current.filter((target) => target.id !== id));
        },
        download: async (target) => {
          document.documentElement.dataset.downloadRequested = target.id;
        },
        open: async (url) => {
          document.documentElement.dataset.openRequested = url;
        },
        prepareOpen: async (target) => {
          document.documentElement.dataset.prepareOpenRequested = target.id;
          return { url: "https://example.com/restricted-proof" };
        },
      }}
      uploadsDisabled={!account.canSync}
    />
  );
}

export function Issue130Proof({ mode }: Readonly<{ mode: Issue130Mode }>) {
  return (
    <WebAppearanceProvider>
      <Issue130ProofContent mode={mode} />
    </WebAppearanceProvider>
  );
}
