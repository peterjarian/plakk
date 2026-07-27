import type { StorageProvider } from "@plakk/shared";
import type { StorageOnboardingOrigin } from "@plakk/shared/PlakkApi";
import { Button } from "@plakk/ui/components/primitives/button";
import { ArrowRight, Check, LoaderCircle, RotateCcw } from "lucide-react";
import { useCallback, useEffect, useState } from "react";

import type { StorageOnboardingRead } from "./storage-onboarding-client.ts";
import { storageProviderChoices, storageProviderLabel } from "./storage-provider-presentation.ts";
import {
  storageOnboardingDestination,
  type StorageOnboardingDestination,
} from "./storage-onboarding.ts";

type ViewState =
  | { readonly kind: "checking" }
  | { readonly kind: "choose" }
  | { readonly kind: "redirecting"; readonly provider: StorageProvider }
  | {
      readonly action: "reauthorize" | "recheck";
      readonly kind: "retry";
      readonly provider: StorageProvider;
    }
  | { readonly kind: "failed" }
  | { readonly kind: "continuing" }
  | { readonly kind: "return-desktop" };

const stateFromDestination = (destination: StorageOnboardingDestination): ViewState => {
  switch (destination.kind) {
    case "choose":
      return destination;
    case "retry":
      return destination;
    case "continue-web":
      return { kind: "continuing" };
    case "return-desktop":
      return destination;
  }
};

export function StorageOnboardingInitialization(props: {
  readonly failed: boolean;
  readonly onRetry: (() => void) | null;
}) {
  return (
    <main className="grid min-h-screen place-items-center bg-background px-6 py-10 text-foreground">
      {props.failed ? (
        <section
          className="grid w-full max-w-xl gap-5 rounded-xl border border-destructive/20 bg-destructive/10 p-6"
          role="alert"
        >
          <div className="grid gap-1">
            <h1 className="font-semibold">Storage setup could not start</h1>
            <p className="text-sm text-muted-foreground">
              Plakk could not prepare your account for storage setup. Try again.
            </p>
          </div>
          <Button
            type="button"
            variant="outline"
            disabled={props.onRetry === null}
            onClick={props.onRetry ?? undefined}
          >
            <RotateCcw aria-hidden="true" />
            Try again
          </Button>
        </section>
      ) : (
        <p className="text-sm text-muted-foreground" role="status">
          Preparing storage setup
        </p>
      )}
    </main>
  );
}

export function StorageOnboardingView(props: {
  readonly begin: (
    provider: StorageProvider,
    origin: StorageOnboardingOrigin,
  ) => Promise<{ readonly url: string }>;
  readonly confirmationRequested: boolean;
  readonly onContinueWeb: () => Promise<void>;
  readonly onRedirect?: (url: string) => void;
  readonly origin: StorageOnboardingOrigin;
  readonly providerHint: StorageProvider | null;
  readonly read: (providerHint: StorageProvider | null) => Promise<StorageOnboardingRead>;
}) {
  const { begin, confirmationRequested, onContinueWeb, origin, providerHint, read } = props;
  const onRedirect =
    props.onRedirect ??
    ((url: string) => {
      window.location.assign(url);
    });
  const [state, setState] = useState<ViewState>({ kind: "checking" });

  const reconstruct = useCallback(async () => {
    setState({ kind: "checking" });
    try {
      const snapshot = await read(providerHint);
      const destination = storageOnboardingDestination(
        snapshot.account,
        snapshot.providerStatus,
        origin,
      );
      const next = stateFromDestination(destination);
      setState(next);
      if (next.kind === "continuing") await onContinueWeb();
    } catch {
      setState({ kind: "failed" });
    }
  }, [onContinueWeb, origin, providerHint, read]);

  useEffect(() => {
    void reconstruct();
  }, [reconstruct]);

  const connect = useCallback(
    async (provider: StorageProvider) => {
      setState({ kind: "redirecting", provider });
      try {
        const { url } = await begin(provider, origin);
        onRedirect(url);
      } catch {
        setState({ kind: "failed" });
      }
    },
    [begin, onRedirect, origin],
  );

  return (
    <main className="grid min-h-screen place-items-center bg-background px-6 py-10 text-foreground">
      <section className="grid w-full max-w-xl gap-7" aria-labelledby="storage-title">
        <header className="grid gap-2 text-center">
          <p className="text-xs font-medium tracking-wide text-muted-foreground uppercase">
            Plakk storage
          </p>
          <h1 id="storage-title" className="text-3xl leading-tight font-semibold tracking-tight">
            Link your storage
          </h1>
          <p className="text-sm text-muted-foreground">
            Your files stay in the provider you choose. Plakk never asks the browser or Desktop app
            to handle provider credentials.
          </p>
        </header>

        {state.kind === "checking" || state.kind === "continuing" ? (
          <div className="grid min-h-48 place-items-center gap-3 text-center" role="status">
            <LoaderCircle
              className="size-6 animate-spin text-muted-foreground"
              aria-hidden="true"
            />
            <p className="text-sm text-muted-foreground">
              {state.kind === "continuing"
                ? "Storage confirmed. Opening Home…"
                : confirmationRequested
                  ? "Confirming your storage connection…"
                  : "Checking your account’s storage…"}
            </p>
          </div>
        ) : state.kind === "choose" ? (
          <div className="grid gap-3" aria-label="Storage providers">
            {storageProviderChoices.map(({ Icon, label, provider }) => (
              <button
                key={provider}
                type="button"
                className="flex min-h-16 w-full items-center gap-4 rounded-xl border border-border bg-card px-5 py-4 text-left transition-colors hover:bg-muted/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                onClick={() => void connect(provider)}
              >
                <Icon className="size-6 shrink-0" />
                <span className="flex-1 font-medium">{label}</span>
                <ArrowRight className="size-4 text-muted-foreground" aria-hidden="true" />
              </button>
            ))}
          </div>
        ) : state.kind === "redirecting" ? (
          <div className="grid min-h-48 place-items-center gap-3 text-center" role="status">
            <LoaderCircle
              className="size-6 animate-spin text-muted-foreground"
              aria-hidden="true"
            />
            <p className="text-sm text-muted-foreground">
              Opening {storageProviderLabel(state.provider)} authorization…
            </p>
          </div>
        ) : state.kind === "return-desktop" ? (
          <div className="grid gap-5 rounded-xl border border-border bg-card p-6 text-center">
            <Check className="mx-auto size-8 text-emerald-600" aria-hidden="true" />
            <div className="grid gap-1">
              <h2 className="text-lg font-semibold">Storage connected</h2>
              <p className="text-sm text-muted-foreground">
                You can return to Plakk Desktop now, or continue to Home on the Web.
              </p>
            </div>
            <Button type="button" onClick={() => void onContinueWeb()}>
              Continue on Web
            </Button>
          </div>
        ) : (
          <div
            className="grid gap-5 rounded-xl border border-destructive/20 bg-destructive/10 p-6"
            role="alert"
          >
            <div className="grid gap-1">
              <h2 className="font-semibold">
                {state.kind === "retry"
                  ? state.action === "recheck"
                    ? "Storage connection is still being confirmed"
                    : "Storage connection not confirmed"
                  : "Storage setup is temporarily unavailable"}
              </h2>
              <p className="text-sm text-muted-foreground">
                {state.kind === "retry"
                  ? state.action === "recheck"
                    ? `${storageProviderLabel(state.provider)} is connected, but the account has not finished updating yet. Try again to recheck it.`
                    : `Plakk did not find an active ${storageProviderLabel(state.provider)} connection for this account. Nothing was changed.`
                  : "Plakk could not confirm your account or contact the storage service. Try again."}
              </p>
            </div>
            <Button
              type="button"
              variant="outline"
              onClick={() =>
                state.kind === "retry" && state.action === "reauthorize"
                  ? void connect(state.provider)
                  : void reconstruct()
              }
            >
              <RotateCcw aria-hidden="true" />
              Try again
            </Button>
          </div>
        )}
      </section>
    </main>
  );
}
