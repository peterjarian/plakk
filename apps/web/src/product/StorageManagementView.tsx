import type { StorageProvider } from "@plakk/shared";
import type {
  StorageCleanupAction,
  StorageCleanupRunResult,
  StorageManagementState,
} from "@plakk/shared/PlakkApi";
import { Button } from "@plakk/ui/components/primitives/button";
import { ExternalLink, LoaderCircle, RotateCcw } from "lucide-react";
import { useCallback, useEffect, useState } from "react";

const providerLabel = (provider: StorageProvider): string => {
  switch (provider) {
    case "GOOGLE_DRIVE":
      return "Google Drive";
    case "ONE_DRIVE":
      return "OneDrive";
    case "DROPBOX":
      return "Dropbox";
  }
};

const actionLabel = (action: StorageCleanupAction) =>
  action === "UNLINK" ? "Unlink" : "Switch provider";

const snippetCountLabel = (count: number) => `${count} ${count === 1 ? "Snippet" : "Snippets"}`;

type ViewState =
  | { readonly kind: "loading" }
  | { readonly kind: "failed" }
  | { readonly kind: "ready"; readonly snapshot: StorageManagementState }
  | {
      readonly action: StorageCleanupAction;
      readonly confirmation: string;
      readonly kind: "confirming";
      readonly snapshot: StorageManagementState;
    }
  | {
      readonly action: StorageCleanupAction;
      readonly kind: "cleaning";
      readonly snapshot: StorageManagementState;
    };

export function StorageManagementView(props: {
  readonly beginCleanup: (
    action: StorageCleanupAction,
    storageProvider: StorageProvider,
    expectedSnippetCount: number,
  ) => Promise<StorageCleanupRunResult>;
  readonly onCompleted: (action: StorageCleanupAction) => void | Promise<void>;
  readonly onRedirect?: (url: string) => void;
  readonly read: () => Promise<StorageManagementState>;
  readonly reauthorize: (storageProvider: StorageProvider) => Promise<{ readonly url: string }>;
  readonly retryCleanup: (storageProvider: StorageProvider) => Promise<StorageCleanupRunResult>;
}) {
  const onRedirect =
    props.onRedirect ??
    ((url: string) => {
      window.location.assign(url);
    });
  const [state, setState] = useState<ViewState>({ kind: "loading" });

  const reconstruct = useCallback(async () => {
    setState({ kind: "loading" });
    try {
      setState({ kind: "ready", snapshot: await props.read() });
    } catch {
      setState({ kind: "failed" });
    }
  }, [props.read]);

  useEffect(() => {
    void reconstruct();
  }, [reconstruct]);

  const completeOrRetain = useCallback(
    async (result: StorageCleanupRunResult, snapshot: StorageManagementState) => {
      if (result.outcome === "COMPLETED") {
        await props.onCompleted(result.action);
        return;
      }
      setState({
        kind: "ready",
        snapshot: {
          ...snapshot,
          affectedSnippetCount: result.progress.totalSnippetCount,
          cleanup: result.progress,
        },
      });
    },
    [props.onCompleted],
  );

  const beginCleanup = useCallback(async () => {
    if (state.kind !== "confirming") return;
    const { action, snapshot } = state;
    const storageProvider = snapshot.storageProvider;
    if (storageProvider === null) return;
    setState({ action, kind: "cleaning", snapshot });
    try {
      await completeOrRetain(
        await props.beginCleanup(action, storageProvider, snapshot.affectedSnippetCount),
        snapshot,
      );
    } catch {
      await reconstruct();
    }
  }, [completeOrRetain, props.beginCleanup, reconstruct, state]);

  const retryCleanup = useCallback(async () => {
    if (state.kind !== "ready") return;
    const snapshot = state.snapshot;
    const storageProvider = snapshot.storageProvider;
    if (storageProvider === null) return;
    const action = snapshot.cleanup?.action ?? "UNLINK";
    setState({ action, kind: "cleaning", snapshot });
    try {
      await completeOrRetain(await props.retryCleanup(storageProvider), snapshot);
    } catch {
      await reconstruct();
    }
  }, [completeOrRetain, props.retryCleanup, reconstruct, state]);

  const reauthorize = useCallback(async () => {
    if (state.kind !== "ready" || state.snapshot.storageProvider === null) return;
    try {
      const { url } = await props.reauthorize(state.snapshot.storageProvider);
      onRedirect(url);
    } catch {
      setState({ kind: "failed" });
    }
  }, [onRedirect, props.reauthorize, state]);

  return (
    <main className="grid min-h-screen place-items-center bg-background px-6 py-10 text-foreground">
      <section className="grid w-full max-w-xl gap-6" aria-labelledby="storage-management-title">
        <header className="grid gap-2 text-center">
          <p className="text-xs font-medium tracking-wide text-muted-foreground uppercase">
            Plakk storage
          </p>
          <h1
            id="storage-management-title"
            className="text-3xl leading-tight font-semibold tracking-tight"
          >
            Manage storage
          </h1>
        </header>

        {state.kind === "loading" || state.kind === "cleaning" ? (
          <div className="grid min-h-48 place-items-center gap-3 text-center" role="status">
            <LoaderCircle
              className="size-6 animate-spin text-muted-foreground"
              aria-hidden="true"
            />
            <p className="text-sm text-muted-foreground">
              {state.kind === "cleaning"
                ? "Removing provider content and Snippet records before disconnecting…"
                : "Reading authoritative storage state…"}
            </p>
          </div>
        ) : state.kind === "failed" ? (
          <div
            className="grid gap-4 rounded-xl border border-destructive/20 bg-destructive/10 p-6"
            role="alert"
          >
            <div>
              <h2 className="font-semibold">Storage management is temporarily unavailable</h2>
              <p className="mt-1 text-sm text-muted-foreground">
                Nothing was changed. Retry the authoritative account read.
              </p>
            </div>
            <Button type="button" variant="outline" onClick={() => void reconstruct()}>
              <RotateCcw aria-hidden="true" />
              Retry
            </Button>
          </div>
        ) : state.kind === "confirming" ? (
          <div className="grid gap-5 rounded-xl border border-destructive/30 bg-card p-6">
            <div className="grid gap-2">
              <h2 className="text-lg font-semibold">
                {actionLabel(state.action)} {providerLabel(state.snapshot.storageProvider!)}?
              </h2>
              <p className="text-sm text-muted-foreground">
                This permanently deletes {snippetCountLabel(state.snapshot.affectedSnippetCount)}{" "}
                and their provider content before disconnecting{" "}
                {providerLabel(state.snapshot.storageProvider!)}.
              </p>
              <p className="text-sm text-muted-foreground">
                Switching offers no migration. A replacement provider can be chosen only after this
                cleanup completes.
              </p>
            </div>
            <label className="grid gap-2 text-sm font-medium">
              Type DELETE to continue
              <input
                className="h-10 rounded-md border border-input bg-background px-3 font-mono text-sm"
                autoComplete="off"
                value={state.confirmation}
                onChange={(event) =>
                  setState({ ...state, confirmation: event.currentTarget.value })
                }
              />
            </label>
            <div className="flex flex-wrap justify-end gap-2">
              <Button
                type="button"
                variant="outline"
                onClick={() => setState({ kind: "ready", snapshot: state.snapshot })}
              >
                Cancel
              </Button>
              <Button
                type="button"
                variant="destructive"
                disabled={state.confirmation !== "DELETE"}
                onClick={() => void beginCleanup()}
              >
                {actionLabel(state.action)} permanently
              </Button>
            </div>
          </div>
        ) : state.snapshot.storageProvider === null ? (
          <div className="grid gap-4 rounded-xl border border-border bg-card p-6 text-center">
            <h2 className="font-semibold">No storage provider is linked</h2>
            <p className="text-sm text-muted-foreground">
              Choose a provider to resume storing Snippets.
            </p>
            <Button type="button" onClick={() => void props.onCompleted("UNLINK")}>
              Choose storage
            </Button>
          </div>
        ) : state.snapshot.cleanup !== null ? (
          <div
            className="grid gap-5 rounded-xl border border-amber-500/30 bg-amber-500/10 p-6"
            role="alert"
          >
            <div className="grid gap-2">
              <h2 className="font-semibold">Storage cleanup needs Retry</h2>
              <p className="text-sm text-muted-foreground">
                {state.snapshot.cleanup.remainingSnippetCount} of{" "}
                {state.snapshot.cleanup.totalSnippetCount} Snippets remain. Completed deletions stay
                deleted, and the credential stays connected until every remaining item is removed.
              </p>
              {state.snapshot.cleanup.lastFailure !== null && (
                <p className="text-sm">{state.snapshot.cleanup.lastFailure}</p>
              )}
            </div>
            <div className="flex flex-wrap gap-2">
              {state.snapshot.connectionStatus !== "CONNECTED" && (
                <Button type="button" variant="outline" onClick={() => void reauthorize()}>
                  Reconnect {providerLabel(state.snapshot.storageProvider)}
                </Button>
              )}
              <Button type="button" onClick={() => void retryCleanup()}>
                <RotateCcw aria-hidden="true" />
                Retry cleanup
              </Button>
            </div>
          </div>
        ) : state.snapshot.connectionStatus === "NEEDS_REAUTHORIZATION" ? (
          <div className="grid gap-5 rounded-xl border border-amber-500/30 bg-card p-6">
            <div className="grid gap-2">
              <h2 className="font-semibold">
                {providerLabel(state.snapshot.storageProvider)} needs reconnection
              </h2>
              <p className="text-sm text-muted-foreground">
                Snippets are preserved. Provider-dependent actions stay paused while you reauthorize
                this same provider; this is not an unlink.
              </p>
            </div>
            <Button type="button" onClick={() => void reauthorize()}>
              Reconnect {providerLabel(state.snapshot.storageProvider)}
            </Button>
          </div>
        ) : state.snapshot.connectionStatus === "NOT_CONNECTED" ? (
          <div className="grid gap-5 rounded-xl border border-amber-500/30 bg-card p-6">
            <h2 className="font-semibold">
              {providerLabel(state.snapshot.storageProvider)} is not connected
            </h2>
            <Button type="button" onClick={() => void reauthorize()}>
              Reconnect {providerLabel(state.snapshot.storageProvider)}
            </Button>
          </div>
        ) : (
          <div className="grid gap-5 rounded-xl border border-border bg-card p-6">
            <div className="grid gap-2">
              <h2 className="text-lg font-semibold">
                {providerLabel(state.snapshot.storageProvider)} connected
              </h2>
              <p className="text-sm text-muted-foreground">
                {snippetCountLabel(state.snapshot.affectedSnippetCount)} would be permanently
                removed by Unlink or Switch.
              </p>
            </div>
            <div className="flex flex-wrap gap-2">
              {state.snapshot.externalDestinationUrl !== null && (
                <a
                  className="inline-flex h-9 items-center justify-center gap-2 rounded-md border border-input bg-background px-4 text-sm font-medium shadow-xs transition-colors hover:bg-accent hover:text-accent-foreground"
                  href={state.snapshot.externalDestinationUrl}
                  target="_blank"
                  rel="noreferrer"
                >
                  Open provider
                  <ExternalLink aria-hidden="true" />
                </a>
              )}
              <Button
                type="button"
                variant="outline"
                onClick={() =>
                  setState({
                    action: "UNLINK",
                    confirmation: "",
                    kind: "confirming",
                    snapshot: state.snapshot,
                  })
                }
              >
                Unlink
              </Button>
              <Button
                type="button"
                variant="destructive"
                onClick={() =>
                  setState({
                    action: "SWITCH",
                    confirmation: "",
                    kind: "confirming",
                    snapshot: state.snapshot,
                  })
                }
              >
                Switch
              </Button>
            </div>
          </div>
        )}
      </section>
    </main>
  );
}
