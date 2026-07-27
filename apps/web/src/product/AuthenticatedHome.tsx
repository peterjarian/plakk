import type { User } from "@plakk/shared";
import * as Schema from "effect/Schema";
import { useCallback, useEffect, useState } from "react";

import { HomeView } from "./HomeView.tsx";
import { AccountProductMirrorError } from "./readable-mirror.ts";
import { accountNeedsStorageOnboarding } from "./storage-onboarding.ts";
import { useWebProduct } from "./web-product-context.tsx";

export function AuthenticatedHome(props: {
  readonly onStorageOnboardingRequired: () => void;
  readonly user: User;
}) {
  const { onStorageOnboardingRequired, user } = props;
  const product = useWebProduct();
  const [signOutError, setSignOutError] = useState<"product-purge" | "workos" | null>(null);
  const handleSignOut = useCallback(async () => {
    if (product.signOut === null) return;
    setSignOutError(null);
    try {
      await product.signOut();
    } catch (cause) {
      setSignOutError(Schema.is(AccountProductMirrorError)(cause) ? "product-purge" : "workos");
    }
  }, [product.signOut]);

  const storageOnboardingRequired =
    product.state.kind === "ready" &&
    product.state.apiAvailability === "available" &&
    accountNeedsStorageOnboarding(product.state.account);
  useEffect(() => {
    if (storageOnboardingRequired) {
      onStorageOnboardingRequired();
    }
  }, [onStorageOnboardingRequired, storageOnboardingRequired]);
  if (storageOnboardingRequired) {
    return (
      <main className="grid min-h-screen place-items-center text-sm text-muted-foreground">
        Opening storage setup
      </main>
    );
  }
  return (
    <HomeView
      user={user}
      state={product.state}
      onRetry={product.retry}
      onSignOut={() => void handleSignOut()}
      signOutError={signOutError}
    />
  );
}
