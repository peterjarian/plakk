import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useAuth } from "@workos/authkit-tanstack-react-start/client";

import { BillingView } from "../../product/BillingView.tsx";
import { productUserFromAuth } from "../../product/product-user.ts";
import { useWebProduct } from "../../product/WebProductProvider.tsx";

export const Route = createFileRoute("/_authenticated/billing")({
  validateSearch: (search: Record<string, unknown>) => ({
    checkout: search.checkout === "returned" ? ("returned" as const) : undefined,
  }),
  component: Billing,
});

function Billing() {
  const auth = useAuth({ ensureSignedIn: true });
  const product = useWebProduct();
  const navigate = useNavigate();
  const search = Route.useSearch();

  if (auth.user === null) {
    return (
      <main className="grid min-h-screen place-items-center text-sm text-muted-foreground">
        Loading account
      </main>
    );
  }

  return (
    <BillingView
      billing={product.billing}
      checkoutReturned={search.checkout === "returned"}
      onBack={() => void navigate({ to: "/snippets" })}
      onNavigate={(url) => window.location.assign(url)}
      onSettings={() => void navigate({ to: "/settings" })}
      onSignOut={() => void product.signOut?.()}
      refresh={product.refresh}
      state={product.state}
      user={productUserFromAuth(auth.user)}
    />
  );
}
