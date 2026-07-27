import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { parseStorageOnboardingRouteSearch } from "@plakk/shared/StorageOnboardingReturn";
import { useCallback } from "react";

import {
  StorageOnboardingInitialization,
  StorageOnboardingView,
} from "../../product/StorageOnboardingView.tsx";
import { StorageManagementView } from "../../product/StorageManagementView.tsx";
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
  const chooseReplacement = useCallback(async () => {
    if (product.refresh !== null) await product.refresh();
    await navigate({
      to: "/storage",
      search: {
        confirmation: undefined,
        mode: undefined,
        origin: "web",
        provider: null,
      },
      replace: true,
    });
  }, [navigate, product.refresh]);
  const continueWeb = useCallback(async () => {
    if (product.refresh === null) {
      throw new Error("The authenticated product cannot be refreshed.");
    }
    await product.refresh();
    await navigate({ to: "/snippets", replace: true });
  }, [navigate, product.refresh]);
  if (
    product.storageOnboarding === null ||
    (search.mode === "manage" && product.storageManagement === null)
  ) {
    return (
      <StorageOnboardingInitialization
        failed={product.state.kind === "failed"}
        onRetry={product.retry}
      />
    );
  }

  if (search.mode === "manage" && product.storageManagement !== null) {
    return (
      <StorageManagementView
        beginCleanup={product.storageManagement.beginCleanup}
        onCompleted={chooseReplacement}
        read={product.storageManagement.read}
        reauthorize={product.storageManagement.reauthorize}
        retryCleanup={product.storageManagement.retryCleanup}
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
