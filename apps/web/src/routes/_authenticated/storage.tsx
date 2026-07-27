import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { parseStorageOnboardingRouteSearch } from "@plakk/shared/StorageOnboardingReturn";
import { useCallback } from "react";

import {
  StorageOnboardingInitialization,
  StorageOnboardingView,
} from "../../product/StorageOnboardingView.tsx";
import { storageOnboardingOrigin } from "../../product/storage-onboarding.ts";
import { useWebProduct } from "../../product/WebProductProvider.tsx";

export const Route = createFileRoute("/_authenticated/storage")({
  validateSearch: (search: Record<string, unknown>) =>
    parseStorageOnboardingRouteSearch((key) => search[key]),
  component: Storage,
});

function Storage() {
  const navigate = useNavigate();
  const search = Route.useSearch();
  const product = useWebProduct();
  const continueWeb = useCallback(async () => {
    if (product.refresh === null) {
      throw new Error("The authenticated product cannot be refreshed.");
    }
    await product.refresh();
    await navigate({ to: "/snippets", replace: true });
  }, [navigate, product.refresh]);
  if (product.storageOnboarding === null) {
    return (
      <StorageOnboardingInitialization
        failed={product.state.kind === "failed"}
        onRetry={product.retry}
      />
    );
  }

  return (
    <StorageOnboardingView
      begin={product.storageOnboarding.begin}
      confirmationRequested={search.confirmation === "provider"}
      onContinueWeb={continueWeb}
      origin={storageOnboardingOrigin(search.origin)}
      providerHint={search.provider}
      read={product.storageOnboarding.read}
    />
  );
}
