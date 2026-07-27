import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useAuth } from "@workos/authkit-tanstack-react-start/client";

import { SettingsView } from "../../product/SettingsView.tsx";
import { useWebProduct } from "../../product/WebProductProvider.tsx";
import { productUserFromAuth } from "../../product/product-user.ts";
import { useWebAppearance } from "../../product/web-appearance.tsx";

export const Route = createFileRoute("/_authenticated/settings")({
  component: Settings,
});

function Settings() {
  const auth = useAuth({ ensureSignedIn: true });
  const product = useWebProduct();
  const navigate = useNavigate();
  const appearance = useWebAppearance();

  if (auth.user === null) {
    return (
      <main className="grid min-h-screen place-items-center text-sm text-muted-foreground">
        Loading account
      </main>
    );
  }

  return (
    <SettingsView
      appearance={appearance.preference}
      onAppearanceChange={appearance.setPreference}
      onBack={() => void navigate({ to: "/snippets" })}
      onBilling={() => void navigate({ to: "/billing", search: { checkout: undefined } })}
      onSignOut={() => void product.signOut?.()}
      onStorage={() =>
        void navigate({
          to: "/storage",
          search: {
            confirmation: undefined,
            mode: "manage",
            origin: "web",
            provider: null,
          },
        })
      }
      state={product.state}
      user={productUserFromAuth(auth.user)}
    />
  );
}
