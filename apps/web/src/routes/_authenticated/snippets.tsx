import type { User } from "@plakk/shared";
import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useAuth } from "@workos/authkit-tanstack-react-start/client";
import * as Schema from "effect/Schema";
import { useCallback, useEffect, useState } from "react";

import { HomeView } from "../../product/HomeView.tsx";
import { accountNeedsStorageOnboarding } from "../../product/storage-onboarding.ts";
import { AccountProductMirrorError } from "../../product/readable-mirror.ts";
import { useWebProduct } from "../../product/WebProductProvider.tsx";

export const Route = createFileRoute("/_authenticated/snippets")({
  component: Snippets,
});

const productUser = (user: NonNullable<ReturnType<typeof useAuth>["user"]>): User => ({
  id: user.id,
  email: user.email,
  firstName: user.firstName,
  lastName: user.lastName,
  createdAt: user.createdAt,
  updatedAt: user.updatedAt,
});

function Snippets() {
  const auth = useAuth({ ensureSignedIn: true });
  const navigate = useNavigate();
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
      void navigate({
        to: "/storage",
        replace: true,
        search: { confirmation: undefined, origin: undefined, provider: null },
      });
    }
  }, [navigate, storageOnboardingRequired]);

  if (auth.user === null) {
    return (
      <main className="grid min-h-screen place-items-center text-sm text-muted-foreground">
        Loading account
      </main>
    );
  }
  if (storageOnboardingRequired) {
    return (
      <main className="grid min-h-screen place-items-center text-sm text-muted-foreground">
        Opening storage setup
      </main>
    );
  }
  return (
    <HomeView
      user={productUser(auth.user)}
      state={product.state}
      onRetry={product.retry}
      onSignOut={() => void handleSignOut()}
      signOutError={signOutError}
    />
  );
}
