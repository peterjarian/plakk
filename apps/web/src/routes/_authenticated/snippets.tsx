import type { User } from "@plakk/shared";
import { createFileRoute } from "@tanstack/react-router";
import { useAuth } from "@workos/authkit-tanstack-react-start/client";

import { HomeView } from "../../product/HomeView.tsx";
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
  const product = useWebProduct();
  if (auth.user === null) {
    return (
      <main className="grid min-h-screen place-items-center text-sm text-muted-foreground">
        Loading account
      </main>
    );
  }
  return (
    <HomeView
      user={productUser(auth.user)}
      state={product.state}
      onRetry={product.retry}
      onSignOut={() => void product.signOut()}
    />
  );
}
