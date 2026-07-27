import type { StorageProvider } from "@plakk/shared";
import type {
  ApiSnippet,
  BillingPlan,
  StorageCleanupAction,
  StorageCleanupRunResult,
  StorageManagementState,
  StorageOnboardingOrigin,
} from "@plakk/shared/PlakkApi";
import { createContext, useContext } from "react";

import type { AccountProductState } from "./account-product-lifetime.ts";
import type { WebSnippetCopyOutcome } from "./snippet-actions.ts";
import type { WebSnippetUploadInput } from "./snippet-upload.ts";
import type { StorageOnboardingRead } from "./storage-onboarding-client.ts";

export type StorageOnboardingActions = {
  readonly begin: (
    provider: StorageProvider,
    origin: StorageOnboardingOrigin,
  ) => Promise<{ readonly url: string }>;
  readonly read: (
    providerHint: StorageProvider | null,
    consumeAuthorization: boolean,
  ) => Promise<StorageOnboardingRead>;
};

export type StorageManagementActions = {
  readonly beginCleanup: (
    action: StorageCleanupAction,
    storageProvider: StorageProvider,
    expectedSnippetCount: number,
  ) => Promise<StorageCleanupRunResult>;
  readonly read: () => Promise<StorageManagementState>;
  readonly reauthorize: (storageProvider: StorageProvider) => Promise<{ readonly url: string }>;
  readonly retryCleanup: (storageProvider: StorageProvider) => Promise<StorageCleanupRunResult>;
};

export type WebProductContextValue = {
  readonly billing: {
    readonly beginCheckout: (plan: BillingPlan) => Promise<{ readonly url: string }>;
    readonly openPortal: () => Promise<{ readonly url: string }>;
  } | null;
  readonly refresh: (() => Promise<void>) | null;
  readonly retry: (() => void) | null;
  readonly signOut: (() => Promise<void>) | null;
  readonly state: AccountProductState;
  readonly storageManagement: StorageManagementActions | null;
  readonly storageOnboarding: StorageOnboardingActions | null;
  readonly snippetActions: {
    readonly copy: (snippet: ApiSnippet) => Promise<WebSnippetCopyOutcome>;
    readonly delete: (snippetId: string) => Promise<void>;
    readonly download: (snippet: ApiSnippet) => Promise<void>;
    readonly open: (confirmedUrl: string) => Promise<void>;
    readonly prepareOpen: (snippet: ApiSnippet) => Promise<{ readonly url: string }>;
  } | null;
  readonly snippetUploads: {
    readonly dismiss: (id: string) => Promise<void>;
    readonly upload: (input: WebSnippetUploadInput) => Promise<void>;
  } | null;
};

export const WebProductContext = createContext<WebProductContextValue | null>(null);

export const useWebProduct = (): WebProductContextValue => {
  const product = useContext(WebProductContext);
  if (product === null) {
    throw new Error("useWebProduct must be used within WebProductProvider.");
  }
  return product;
};
