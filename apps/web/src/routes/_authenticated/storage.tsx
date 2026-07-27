import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useCallback } from "react";

import { StorageOnboardingView } from "../../product/StorageOnboardingView.tsx";
import {
  storageOnboardingOrigin,
  storageOnboardingProvider,
} from "../../product/storage-onboarding.ts";
import { useWebProduct } from "../../product/WebProductProvider.tsx";
import { useWebStorageOnboarding } from "../../product/WebStorageOnboardingProvider.tsx";

export const Route = createFileRoute("/_authenticated/storage")({
  validateSearch: (search: Record<string, unknown>) => ({
    confirmation: search.confirmation === "provider" ? ("provider" as const) : undefined,
    origin: search.origin === "desktop" ? ("desktop" as const) : undefined,
    provider: storageOnboardingProvider(search.provider),
  }),
  component: Storage,
});

function Storage() {
  const navigate = useNavigate();
  const search = Route.useSearch();
  const onboarding = useWebStorageOnboarding();
  const product = useWebProduct();
  const continueWeb = useCallback(async () => {
    if (product.refresh === null) {
      throw new Error("The authenticated product cannot be refreshed.");
    }
    await product.refresh();
    await navigate({ to: "/snippets", replace: true });
  }, [navigate, product.refresh]);

  return (
    <StorageOnboardingView
      begin={onboarding.begin}
      confirmationRequested={search.confirmation === "provider"}
      onContinueWeb={continueWeb}
      origin={storageOnboardingOrigin(search.origin)}
      providerHint={search.provider}
      read={onboarding.read}
    />
  );
}
