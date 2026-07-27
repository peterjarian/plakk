import { deriveSnippetPresentation, type User } from "@plakk/shared";
import type { StorageProviderStatus } from "@plakk/shared/PlakkApi";
import { AppHeader } from "@plakk/ui/components/AppHeader";
import { SnippetList } from "@plakk/ui/components/SnippetList";
import { PublishedSnippetRow } from "@plakk/ui/components/SnippetRow";
import { Button } from "@plakk/ui/components/primitives/button";
import * as DateTime from "effect/DateTime";

import type { AccountProductState } from "./account-product-lifetime.ts";

const storageProviderLabel = {
  DROPBOX: "Dropbox",
  GOOGLE_DRIVE: "Google Drive",
  ONE_DRIVE: "OneDrive",
} as const satisfies Record<StorageProviderStatus["storageProvider"], string>;

const trialEndDate = (trialEndsAt: string) =>
  DateTime.formatUtc(DateTime.makeUnsafe(trialEndsAt), {
    dateStyle: "long",
    locale: "en",
  });

export function HomeView(props: {
  readonly user: User;
  readonly state: AccountProductState;
  readonly onRetry: (() => void) | null;
  readonly onSignOut: () => void;
  readonly signOutError: "product-purge" | "workos" | null;
}) {
  const { onRetry, onSignOut, signOutError, state, user } = props;
  const now = DateTime.toEpochMillis(DateTime.nowUnsafe());
  const storageProvider = state.kind === "ready" ? state.account.storageProvider : null;

  return (
    <main className="flex min-h-screen flex-col bg-background text-foreground" aria-label="Plakk">
      <AppHeader
        className="h-14 border-b border-border"
        user={user}
        onSignOutClick={onSignOut}
        storageAction={
          <span className="text-xs text-muted-foreground">
            {storageProvider === null ? "Web · Read only" : storageProviderLabel[storageProvider]}
          </span>
        }
      />

      <div className="mx-auto flex w-full max-w-3xl min-h-0 flex-1 flex-col px-6 py-8">
        <div className="mb-7">
          <p className="text-xs font-medium tracking-wide text-muted-foreground uppercase">Home</p>
          <h1 className="text-2xl font-semibold tracking-tight">Your snippets</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            The complete published collection for your Plakk account.
          </p>
          {state.kind === "ready" &&
            state.apiAvailability === "available" &&
            state.liveConnection === "connected" && (
              <p className="mt-2 text-xs text-muted-foreground" role="status">
                Live updates connected
              </p>
            )}
        </div>

        {state.kind === "ready" && state.localReadPerformance === "degraded" && (
          <p
            className="mb-4 rounded-lg border border-border bg-muted/40 px-4 py-3 text-sm text-muted-foreground"
            role="status"
          >
            Fast local reads are unavailable in this browser session. Plakk will keep using the
            online service normally.
          </p>
        )}

        {state.kind === "ready" &&
          (state.account.accessEntitlement.status === "TRIAL_ACTIVE" ? (
            <p
              className="mb-4 rounded-lg border border-border bg-muted/40 px-4 py-3 text-sm text-muted-foreground"
              role="status"
            >
              <strong className="font-medium text-foreground">Trial active.</strong> Your account
              trial ends {trialEndDate(state.account.accessEntitlement.trialEndsAt)}.
            </p>
          ) : (
            <div
              className="mb-4 rounded-lg border border-destructive/20 bg-destructive/10 px-4 py-3 text-sm text-destructive"
              role="alert"
            >
              <strong>Billing access required.</strong> Your snippets are preserved. Restore billing
              access to resume normal use. Add, Copy, Download, and Open remain unavailable.
            </div>
          ))}

        {signOutError !== null && (
          <div
            className="mb-4 rounded-lg border border-destructive/20 bg-destructive/10 px-4 py-3 text-sm text-destructive"
            role="alert"
          >
            {signOutError === "product-purge"
              ? "Plakk could not confirm that this account’s local product data was cleared, so sign-out was stopped. Try signing out again."
              : "Plakk cleared this account’s product data, but WorkOS could not sign you out. Try signing out again."}
          </div>
        )}

        {state.kind === "idle" || state.kind === "loading" ? (
          <div
            className="grid min-h-48 flex-1 place-items-center text-sm text-muted-foreground"
            role="status"
          >
            <span>Loading snippets</span>
          </div>
        ) : state.kind === "failed" ? (
          <div
            className="flex items-center justify-between gap-4 rounded-lg border border-destructive/20 bg-destructive/10 px-4 py-3 text-sm text-destructive"
            role="alert"
          >
            <span>
              <strong>Product unavailable.</strong> Plakk couldn’t load your snippets.
            </span>
            {onRetry !== null && (
              <Button type="button" variant="ghost" size="sm" onClick={onRetry}>
                Try again
              </Button>
            )}
          </div>
        ) : (
          <>
            {state.apiAvailability === "available" && state.liveConnection === "reconnecting" && (
              <div
                className="mb-4 rounded-lg border border-border bg-muted/40 px-4 py-3 text-sm text-muted-foreground"
                role="status"
              >
                <span className="font-medium text-foreground">Live updates reconnecting.</span> Your
                last-confirmed snippets remain visible. This status describes update freshness;
                commands check the API when used.
              </div>
            )}
            {state.apiAvailability === "unavailable" && (
              <div
                className="mb-4 flex items-center justify-between gap-4 rounded-lg border border-destructive/20 bg-destructive/10 px-4 py-3 text-sm text-destructive"
                role="alert"
              >
                <span>
                  <strong>API unavailable.</strong> Showing your last-confirmed snippets. Remote
                  actions are paused.
                </span>
                {onRetry !== null && (
                  <Button type="button" variant="ghost" size="sm" onClick={onRetry}>
                    Try again
                  </Button>
                )}
              </div>
            )}
            <SnippetList
              empty={state.snippets.length === 0}
              emptyDescription="Published snippets from your Plakk account will appear here."
            >
              {state.snippets.map((snippet) => (
                <PublishedSnippetRow
                  key={snippet.id}
                  snippet={snippet}
                  presentation={deriveSnippetPresentation({ fileName: snippet.fileName })}
                  now={now}
                />
              ))}
            </SnippetList>
          </>
        )}
      </div>
    </main>
  );
}
