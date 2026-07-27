import type { User } from "@plakk/shared";
import { formatAccountBillingInstant, type BillingPlan } from "@plakk/shared/PlakkApi";
import { AppHeader } from "@plakk/ui/components/AppHeader";
import { Button } from "@plakk/ui/components/primitives/button";
import { ArrowLeft, CircleHelp } from "lucide-react";
import { useEffect, useState } from "react";

import type { AccountProductState } from "./account-product-lifetime.ts";
import type { WebProductContextValue } from "./web-product-context.tsx";

const CONFIRMATION_DELAYS_MILLIS = [0, 1_500, 3_000, 6_000, 12_000, 15_000, 15_000] as const;

export function BillingView(props: {
  readonly billing: WebProductContextValue["billing"];
  readonly checkoutReturned: boolean;
  readonly onBack: () => void;
  readonly onNavigate: (url: string) => void;
  readonly onSettings: () => void;
  readonly onSignOut: () => void;
  readonly refresh: (() => Promise<void>) | null;
  readonly state: AccountProductState;
  readonly user: User;
}) {
  const {
    billing,
    checkoutReturned,
    onBack,
    onNavigate,
    onSettings,
    onSignOut,
    refresh,
    state,
    user,
  } = props;
  const [pendingAction, setPendingAction] = useState<BillingPlan | "PORTAL" | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [confirmationRun, setConfirmationRun] = useState(0);
  const [confirmationTimedOut, setConfirmationTimedOut] = useState(false);
  const account = state.kind === "ready" ? state.account : null;
  const entitlement = account?.accessEntitlement ?? null;
  const paidConfirmed = entitlement?.status === "PAID_ACTIVE";

  useEffect(() => {
    if (!checkoutReturned || paidConfirmed || refresh === null) return;
    let active = true;
    let timer: number | null = null;
    setConfirmationTimedOut(false);

    const check = async (attempt: number) => {
      if (!active) return;
      try {
        await refresh();
        if (active) setActionError(null);
      } catch {
        if (active) setActionError("Plakk could not confirm billing yet.");
      }
      if (!active) return;
      const nextAttempt = attempt + 1;
      const delay = CONFIRMATION_DELAYS_MILLIS[nextAttempt];
      if (delay === undefined) {
        setConfirmationTimedOut(true);
        return;
      }
      timer = window.setTimeout(() => void check(nextAttempt), delay);
    };

    timer = window.setTimeout(() => void check(0), CONFIRMATION_DELAYS_MILLIS[0]);
    return () => {
      active = false;
      if (timer !== null) window.clearTimeout(timer);
    };
  }, [checkoutReturned, confirmationRun, paidConfirmed, refresh]);

  const beginCheckout = (plan: BillingPlan) => {
    if (billing === null || pendingAction !== null) return;
    setActionError(null);
    setPendingAction(plan);
    void billing.beginCheckout(plan).then(
      ({ url }) => onNavigate(url),
      () => {
        setPendingAction(null);
        setActionError("Plakk could not start Polar checkout. Try again.");
      },
    );
  };
  const openPortal = () => {
    if (billing === null || pendingAction !== null) return;
    setActionError(null);
    setPendingAction("PORTAL");
    void billing.openPortal().then(
      ({ url }) => onNavigate(url),
      () => {
        setPendingAction(null);
        setActionError("Plakk could not open Polar billing recovery. Try again.");
      },
    );
  };

  const checkoutButtons = (
    <div className="flex flex-wrap gap-3">
      <Button
        type="button"
        disabled={billing === null || pendingAction !== null}
        onClick={() => beginCheckout("MONTHLY")}
      >
        {pendingAction === "MONTHLY" ? "Opening checkout…" : "Subscribe monthly"}
      </Button>
      <Button
        type="button"
        variant="outline"
        disabled={billing === null || pendingAction !== null}
        onClick={() => beginCheckout("ANNUAL")}
      >
        {pendingAction === "ANNUAL" ? "Opening checkout…" : "Subscribe annually"}
      </Button>
    </div>
  );

  return (
    <main className="flex min-h-screen flex-col bg-background text-foreground">
      <AppHeader
        className="h-14 border-b border-border"
        user={user}
        onSettingsClick={onSettings}
        onSignOutClick={onSignOut}
        storageAction={
          <a
            className="inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground"
            href="mailto:help@plakk.io"
          >
            <CircleHelp className="size-3.5" aria-hidden="true" />
            Help
          </a>
        }
      />
      <div className="mx-auto grid w-full max-w-2xl gap-6 px-4 py-6 sm:px-6 sm:py-8">
        <div>
          <Button type="button" variant="ghost" size="sm" className="-ml-2" onClick={onBack}>
            <ArrowLeft />
            Back to Home
          </Button>
          <p className="mt-6 text-xs font-medium tracking-wide text-muted-foreground uppercase">
            Billing
          </p>
          <h1 className="text-2xl font-semibold tracking-tight">Plakk subscription</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            Checkout and payment recovery are hosted securely by Polar.
          </p>
        </div>

        {checkoutReturned &&
          (paidConfirmed ? (
            <div
              className="rounded-lg border border-emerald-500/30 bg-emerald-500/10 px-4 py-3 text-sm"
              role="status"
            >
              <strong>Subscription confirmed by Polar.</strong> Paid access is active.
            </div>
          ) : (
            <div
              className="rounded-lg border border-border bg-muted/40 px-4 py-3 text-sm"
              role="status"
            >
              <strong>Waiting for Polar confirmation.</strong> Returning from checkout does not
              unlock Plakk. Normal access changes only after the backend confirms the paid benefit.
              {confirmationTimedOut && (
                <div className="mt-3">
                  <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    onClick={() => setConfirmationRun((run) => run + 1)}
                  >
                    Check again
                  </Button>
                </div>
              )}
            </div>
          ))}

        {state.kind !== "ready" ? (
          <div className="rounded-lg border border-border px-4 py-6 text-sm text-muted-foreground">
            Loading backend-confirmed billing status…
          </div>
        ) : entitlement?.status === "TRIAL_ACTIVE" ? (
          <section className="grid gap-4 rounded-xl border border-border p-5">
            <div>
              <h2 className="font-medium">Trial active</h2>
              <p className="mt-1 text-sm text-muted-foreground">
                Your trial ends exactly {formatAccountBillingInstant(entitlement.trialEndsAt)}.
              </p>
            </div>
            <div
              className="rounded-lg border border-amber-500/30 bg-amber-500/10 px-4 py-3 text-sm"
              role="alert"
            >
              <strong>Billing starts immediately.</strong> Subscribing permanently ends any unused
              trial time.
            </div>
            {checkoutButtons}
          </section>
        ) : entitlement?.status === "PAID_ACTIVE" ? (
          <section className="grid gap-4 rounded-xl border border-border p-5">
            <div>
              <h2 className="font-medium">
                {entitlement.cancelAtPeriodEnd ? "Subscription canceled" : "Paid access active"}
              </h2>
              <p className="mt-1 text-sm text-muted-foreground">
                Access remains active through {formatAccountBillingInstant(entitlement.paidThrough)}
                .
                {entitlement.cancelAtPeriodEnd
                  ? " Your trial will not resume after that instant."
                  : " Polar will manage the next renewal."}
              </p>
            </div>
            <Button
              type="button"
              className="w-fit"
              variant="outline"
              disabled={billing === null || pendingAction !== null}
              onClick={openPortal}
            >
              {pendingAction === "PORTAL" ? "Opening Polar…" : "Manage billing"}
            </Button>
          </section>
        ) : entitlement?.status === "GRACE_ACTIVE" ? (
          <section className="grid gap-4 rounded-xl border border-destructive/30 bg-destructive/5 p-5">
            <div role="alert">
              <h2 className="font-medium text-destructive">Payment needs attention</h2>
              <p className="mt-1 text-sm text-muted-foreground">
                Normal use continues through {formatAccountBillingInstant(entitlement.graceEndsAt)}.
                Update your payment method before then to avoid restriction.
              </p>
            </div>
            <Button
              type="button"
              className="w-fit"
              disabled={billing === null || pendingAction !== null}
              onClick={openPortal}
            >
              {pendingAction === "PORTAL" ? "Opening Polar…" : "Recover billing"}
            </Button>
          </section>
        ) : (
          <section className="grid gap-4 rounded-xl border border-destructive/30 bg-destructive/5 p-5">
            <div role="alert">
              <h2 className="font-medium text-destructive">Billing access required</h2>
              <p className="mt-1 text-sm text-muted-foreground">
                Your snippets and provider content are preserved. Restore billing to resume Add,
                Copy, Download, and Open.
              </p>
            </div>
            <div className="grid gap-3 sm:flex sm:flex-wrap">
              <Button
                type="button"
                disabled={billing === null || pendingAction !== null}
                onClick={openPortal}
              >
                {pendingAction === "PORTAL" ? "Opening Polar…" : "Recover billing"}
              </Button>
              {checkoutButtons}
            </div>
          </section>
        )}

        {account?.blockedReasons.includes("storage") && (
          <div
            className="rounded-lg border border-border bg-muted/40 px-4 py-3 text-sm text-muted-foreground"
            role="status"
          >
            <strong className="text-foreground">Storage remains separate.</strong> Confirming or
            recovering billing will not clear this account’s storage restriction.
          </div>
        )}

        {actionError !== null && (
          <div
            className="rounded-lg border border-destructive/30 bg-destructive/10 px-4 py-3 text-sm text-destructive"
            role="alert"
          >
            {actionError}
          </div>
        )}
      </div>
    </main>
  );
}
