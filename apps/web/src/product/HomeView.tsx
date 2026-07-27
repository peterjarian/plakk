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

export function HomeView(props: {
  readonly user: User;
  readonly state: AccountProductState;
  readonly onRetry: (() => void) | null;
  readonly onSignOut: () => void;
  readonly signOutError: { readonly cause: unknown } | null;
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

        {signOutError !== null && (
          <div
            className="mb-4 rounded-lg border border-destructive/20 bg-destructive/10 px-4 py-3 text-sm text-destructive"
            role="alert"
          >
            Plakk cleared this account’s product data, but WorkOS could not sign you out. Try
            signing out again.
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
              <strong>API unavailable.</strong> Plakk couldn’t load your snippets.
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
