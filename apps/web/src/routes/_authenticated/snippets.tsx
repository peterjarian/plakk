import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useAuth } from "@workos/authkit-tanstack-react-start/client";
import { useCallback } from "react";

import { AuthenticatedHome } from "../../product/AuthenticatedHome.tsx";
import { productUserFromAuth } from "../../product/product-user.ts";

export const Route = createFileRoute("/_authenticated/snippets")({
  component: Snippets,
});

function Snippets() {
  const auth = useAuth({ ensureSignedIn: true });
  const navigate = useNavigate();
  const openStorageOnboarding = useCallback(() => {
    void navigate({
      to: "/storage",
      replace: true,
      search: { confirmation: undefined, origin: undefined, provider: null },
    });
  }, [navigate]);
  const openBilling = useCallback(() => {
    void navigate({ to: "/billing", search: { checkout: undefined } });
  }, [navigate]);
  const openSettings = useCallback(() => {
    void navigate({ to: "/settings" });
  }, [navigate]);

  if (auth.user === null) {
    return (
      <main className="grid min-h-screen place-items-center text-sm text-muted-foreground">
        Loading account
      </main>
    );
  }
  return (
    <AuthenticatedHome
      onBilling={openBilling}
      onSettings={openSettings}
      onStorageOnboardingRequired={openStorageOnboarding}
      user={productUserFromAuth(auth.user)}
    />
  );
}
