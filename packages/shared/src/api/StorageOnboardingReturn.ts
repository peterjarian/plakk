import * as Schema from "effect/Schema";

import { StorageProviderLiteral, type StorageProvider } from "../index.ts";
import type { StorageOnboardingOrigin } from "./PlakkApi.ts";

const StorageOnboardingReturnOriginSchema = Schema.Literals(["web", "desktop"] as const);
const StorageOnboardingConfirmationSchema = Schema.Literal("provider");

export type StorageOnboardingRouteSearch = {
  readonly confirmation: "provider" | undefined;
  readonly origin: "web" | "desktop" | undefined;
  readonly provider: StorageProvider | null;
};

export const parseStorageOnboardingRouteSearch = (
  get: (key: "confirmation" | "origin" | "provider") => unknown,
): StorageOnboardingRouteSearch => {
  const confirmation = get("confirmation");
  const origin = get("origin");
  const provider = get("provider");
  return {
    confirmation: Schema.is(StorageOnboardingConfirmationSchema)(confirmation)
      ? confirmation
      : undefined,
    origin: Schema.is(StorageOnboardingReturnOriginSchema)(origin) ? origin : undefined,
    provider: Schema.is(StorageProviderLiteral)(provider) ? provider : null,
  };
};

export const storageOnboardingRouteSearchParams = (
  search: StorageOnboardingRouteSearch,
): URLSearchParams => {
  const params = new URLSearchParams();
  if (search.provider !== null) params.set("provider", search.provider);
  if (search.origin !== undefined) params.set("origin", search.origin);
  if (search.confirmation !== undefined) {
    params.set("confirmation", search.confirmation);
  }
  return params;
};

export const storageOnboardingReturnSearch = (
  provider: StorageProvider,
  origin: StorageOnboardingOrigin,
): StorageOnboardingRouteSearch => ({
  confirmation: "provider",
  origin: origin === "DESKTOP" ? "desktop" : "web",
  provider,
});
