import type { User } from "@plakk/shared";
import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useAuth } from "@workos/authkit-tanstack-react-start/client";
import { useCallback } from "react";

import { AuthenticatedHome } from "../../product/AuthenticatedHome.tsx";

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
  const openStorageOnboarding = useCallback(() => {
    void navigate({
      to: "/storage",
      replace: true,
      search: { confirmation: undefined, origin: undefined, provider: null },
    });
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
      onStorageOnboardingRequired={openStorageOnboarding}
      user={productUser(auth.user)}
    />
  );
}
