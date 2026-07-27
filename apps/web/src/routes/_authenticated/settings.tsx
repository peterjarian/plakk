import { AppHeader } from "@plakk/ui/components/AppHeader";
import { Button } from "@plakk/ui/components/primitives/button";
import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useAuth } from "@workos/authkit-tanstack-react-start/client";
import { ArrowLeft, CircleHelp, CreditCard } from "lucide-react";

import { useWebProduct } from "../../product/WebProductProvider.tsx";
import { productUserFromAuth } from "../../product/product-user.ts";

export const Route = createFileRoute("/_authenticated/settings")({
  component: Settings,
});

function Settings() {
  const auth = useAuth({ ensureSignedIn: true });
  const product = useWebProduct();
  const navigate = useNavigate();

  if (auth.user === null) {
    return (
      <main className="grid min-h-screen place-items-center text-sm text-muted-foreground">
        Loading account
      </main>
    );
  }

  return (
    <main className="flex min-h-screen flex-col bg-background text-foreground">
      <AppHeader
        className="h-14 border-b border-border"
        user={productUserFromAuth(auth.user)}
        onSignOutClick={() => void product.signOut?.()}
        storageAction={<span className="text-xs text-muted-foreground">Settings</span>}
      />
      <div className="mx-auto grid w-full max-w-2xl gap-6 px-6 py-8">
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="-ml-2 w-fit"
          onClick={() => void navigate({ to: "/snippets" })}
        >
          <ArrowLeft />
          Back to Home
        </Button>
        <div>
          <p className="text-xs font-medium tracking-wide text-muted-foreground uppercase">
            Settings
          </p>
          <h1 className="text-2xl font-semibold tracking-tight">Account</h1>
          <p className="mt-1 text-sm text-muted-foreground">{auth.user.email}</p>
        </div>
        <section className="grid gap-3 rounded-xl border border-border p-5">
          <h2 className="font-medium">Subscription</h2>
          <p className="text-sm text-muted-foreground">
            Billing controls remain available even when normal product actions are restricted.
          </p>
          <Button
            type="button"
            variant="outline"
            className="w-fit"
            onClick={() => void navigate({ to: "/billing", search: { checkout: undefined } })}
          >
            <CreditCard />
            Manage billing
          </Button>
        </section>
        <section className="grid gap-3 rounded-xl border border-border p-5">
          <h2 className="font-medium">Help</h2>
          <p className="text-sm text-muted-foreground">
            Account help and sign-out remain available in every billing state.
          </p>
          <a
            className="inline-flex w-fit items-center gap-2 text-sm font-medium underline-offset-4 hover:underline"
            href="mailto:help@plakk.io"
          >
            <CircleHelp className="size-4" aria-hidden="true" />
            Contact Plakk help
          </a>
        </section>
      </div>
    </main>
  );
}
