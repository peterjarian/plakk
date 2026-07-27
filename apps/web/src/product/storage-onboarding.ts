import type { StorageProvider } from "@plakk/shared";
import type {
  AccountStatus,
  StorageOnboardingOrigin,
  StorageProviderStatus,
} from "@plakk/shared/PlakkApi";

export type StorageOnboardingDestination =
  | { readonly kind: "choose" }
  | { readonly kind: "retry"; readonly provider: StorageProvider }
  | { readonly kind: "continue-web" }
  | { readonly kind: "return-desktop" };

export const storageOnboardingOrigin = (value: unknown): StorageOnboardingOrigin =>
  value === "desktop" ? "DESKTOP" : "WEB";

export const accountNeedsStorageOnboarding = (account: AccountStatus): boolean =>
  account.blockedReasons.includes("storage");

export const storageOnboardingDestination = (
  account: AccountStatus,
  providerStatus: StorageProviderStatus | null,
  origin: StorageOnboardingOrigin,
): StorageOnboardingDestination => {
  const confirmedProvider =
    providerStatus?.status === "CONNECTED" &&
    account.storageProvider === providerStatus.storageProvider &&
    !accountNeedsStorageOnboarding(account);
  if (confirmedProvider) {
    return origin === "DESKTOP" ? { kind: "return-desktop" } : { kind: "continue-web" };
  }

  const provider = providerStatus?.storageProvider ?? account.storageProvider;
  return provider === null ? { kind: "choose" } : { kind: "retry", provider };
};
