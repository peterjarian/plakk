import { AppHeader } from "@plakk/ui/components/AppHeader";
import { SnippetList } from "@plakk/ui/components/SnippetList";
import { SnippetRow } from "@plakk/ui/components/SnippetRow";
import { Button } from "@plakk/ui/primitives/button";
import * as DateTime from "effect/DateTime";
import { LoaderCircle, Plus, TriangleAlert } from "lucide-react";
import { useEffect, useRef, useState } from "react";

import { SnippetComposer } from "../components/SnippetComposer.tsx";
import { StorageProviderIcon, storageProviderLabel } from "../components/StorageProviderIcon.tsx";
import { SyncStatusIndicator, type SyncStatus } from "../components/SyncStatusIndicator.tsx";
import type { WebAppModel } from "../App.tsx";
import type { WebSnippet } from "../hooks/useSnippets.ts";
import { storageState } from "../lib/storageState.ts";

const messageFrom = (cause: unknown, fallback: string) =>
  cause instanceof Error && cause.message.trim() ? cause.message : fallback;

export function Home(props: { readonly plakk: WebAppModel; readonly onSettings: () => void }) {
  const { plakk } = props;
  const storage = storageState(plakk.capability);
  const blocked = storage.kind !== "connected" || !storage.canSync;
  const billingBlocked =
    plakk.capability.status === "ONLINE" &&
    plakk.capability.account.blockedReasons.includes("billing");
  const [isDragging, setIsDragging] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const [copiedId, setCopiedId] = useState<string | null>(null);
  const [copyingId, setCopyingId] = useState<string | null>(null);
  const [now, setNow] = useState(() => DateTime.toEpochMillis(DateTime.nowUnsafe()));
  const copiedTimer = useRef<number | undefined>(undefined);

  useEffect(() => {
    const interval = window.setInterval(
      () => setNow(DateTime.toEpochMillis(DateTime.nowUnsafe())),
      60_000,
    );
    return () => window.clearInterval(interval);
  }, []);
  useEffect(
    () => () => {
      if (copiedTimer.current !== undefined) window.clearTimeout(copiedTimer.current);
    },
    [],
  );

  const run = (operation: Promise<void>, fallback: string) => {
    setActionError(null);
    void operation.catch((cause) => setActionError(messageFrom(cause, fallback)));
  };
  const copy = (snippet: WebSnippet) => {
    setCopyingId(snippet.id);
    void plakk
      .copySnippet(snippet)
      .then(
        () => {
          setCopiedId(snippet.id);
          if (copiedTimer.current !== undefined) window.clearTimeout(copiedTimer.current);
          copiedTimer.current = window.setTimeout(() => setCopiedId(null), 1_200);
        },
        (cause) => setActionError(messageFrom(cause, "Could not copy this snippet.")),
      )
      .finally(() => setCopyingId(null));
  };
  const syncStatus: SyncStatus = plakk.loading
    ? "CHECKING"
    : plakk.capability.status === "OFFLINE"
      ? "OFFLINE"
      : blocked
        ? "PAUSED"
        : plakk.syncStatus === "CONNECTED"
          ? "CONNECTED"
          : "RECONNECTING";

  return (
    <main
      className="flex min-h-screen flex-col bg-background text-foreground"
      aria-label="Plakk"
      onPaste={(event) => {
        if (blocked) return;
        const target = event.target;
        if (
          target instanceof HTMLElement &&
          (target.isContentEditable || target.matches("input, textarea, select"))
        ) {
          return;
        }
        const files = Array.from(event.clipboardData.files);
        if (files.length > 0) run(plakk.addFiles(files), "Could not add pasted files.");
        else {
          const text = event.clipboardData.getData("text/plain").trim();
          if (text) run(plakk.addText(text), "Could not add pasted text.");
        }
      }}
      onDragOver={(event) => {
        event.preventDefault();
        if (!blocked) setIsDragging(true);
      }}
      onDragLeave={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setIsDragging(false);
      }}
      onDrop={(event) => {
        event.preventDefault();
        setIsDragging(false);
        if (blocked) return;
        const files = Array.from(event.dataTransfer.files);
        if (files.length > 0) run(plakk.addFiles(files), "Could not add dropped files.");
        else {
          const text = event.dataTransfer.getData("text/plain").trim();
          if (text) run(plakk.addText(text), "Could not add dropped text.");
        }
      }}
    >
      <div className="mx-auto flex w-full max-w-3xl flex-1 flex-col">
        <AppHeader
          className="mt-3"
          user={plakk.user!}
          onSettingsClick={props.onSettings}
          onSignOutClick={() => run(plakk.signOut(), "Could not sign out.")}
          statusIndicator={<SyncStatusIndicator status={syncStatus} />}
          storageAction={
            storage.kind === "connected" ? (
              <Button
                type="button"
                variant="ghost"
                size="sm"
                onClick={() => plakk.openExternal(storage.destinationUrl)}
              >
                <StorageProviderIcon provider={storage.provider} />
                {storageProviderLabel(storage.provider)}
              </Button>
            ) : null
          }
        />
        <div className="flex min-h-0 flex-1 flex-col px-6 pb-6">
          <div className="sticky top-0 z-20 bg-background pt-5 pb-4">
            {blocked && !plakk.loading && (
              <div className="mb-2 flex items-center gap-2 rounded-md bg-muted px-2.5 py-1.5 text-xs text-muted-foreground">
                <TriangleAlert className="size-3.5 text-amber-600" />
                <span className="min-w-0 flex-1">
                  {plakk.capability.status === "OFFLINE"
                    ? "Offline — your saved snippet list remains available."
                    : billingBlocked
                      ? "Sync is paused until billing is resolved."
                      : "Sync is paused until account storage is ready."}
                </span>
                <Button
                  type="button"
                  variant="ghost"
                  size="xs"
                  onClick={() =>
                    billingBlocked
                      ? plakk.openExternal("https://app.plakk.io/billing")
                      : props.onSettings()
                  }
                >
                  {billingBlocked ? "Manage billing" : "Finish setup"}
                </Button>
              </div>
            )}
            <SnippetComposer
              disabled={blocked}
              onSubmit={(text) => run(plakk.addText(text), "Could not add this snippet.")}
              onFiles={(files) =>
                run(plakk.addFiles(Array.from(files)), "Could not add these files.")
              }
            />
            {(actionError ?? plakk.error) && (
              <p className="mt-2 text-xs text-destructive" role="alert">
                {actionError ?? plakk.error}
              </p>
            )}
          </div>
          {plakk.loading && plakk.snippets.length === 0 ? (
            <div className="grid flex-1 place-items-center text-muted-foreground">
              <LoaderCircle className="size-5 animate-spin" />
            </div>
          ) : plakk.error && plakk.snippets.length === 0 ? (
            <Button
              type="button"
              variant="ghost"
              onClick={() => run(plakk.refresh(), "Could not refresh.")}
            >
              Try again
            </Button>
          ) : (
            <SnippetList.Root>
              <SnippetList.Heading />
              {plakk.snippets.length === 0 ? (
                <SnippetList.Empty />
              ) : (
                <SnippetList.Items>
                  {plakk.snippets.map((snippet) => (
                    <SnippetRow
                      key={snippet.id}
                      snippet={snippet}
                      presentation={snippet.presentation}
                      now={now}
                      copied={copiedId === snippet.id}
                      copying={copyingId === snippet.id}
                      copyDisabled={snippet.kind !== "PUBLISHED"}
                      onCopy={() => copy(snippet)}
                      onDelete={() =>
                        run(plakk.deleteSnippet(snippet), "Could not remove this snippet.")
                      }
                      onDownload={() =>
                        run(plakk.downloadSnippet(snippet), "Could not download this snippet.")
                      }
                      onOpenLink={plakk.openExternal}
                      contentMode="remote"
                    />
                  ))}
                </SnippetList.Items>
              )}
            </SnippetList.Root>
          )}
        </div>
      </div>
      {isDragging && (
        <div className="pointer-events-none fixed inset-0 z-50 grid place-items-center bg-blue-500/15">
          <div className="grid size-9 place-items-center rounded-full bg-blue-500 text-white">
            <Plus className="size-5" />
          </div>
        </div>
      )}
    </main>
  );
}
