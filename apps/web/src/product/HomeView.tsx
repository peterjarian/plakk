import { deriveSnippetPresentation, type User } from "@plakk/shared";
import {
  accountCanSync,
  type ApiSnippet,
  type StorageProviderStatus,
} from "@plakk/shared/PlakkApi";
import { RpcError } from "@plakk/shared/RpcError";
import { AppHeader } from "@plakk/ui/components/AppHeader";
import { ExternalLinkConfirmationDialog } from "@plakk/ui/components/ExternalLinkConfirmationDialog";
import { SnippetComposer } from "@plakk/ui/components/SnippetComposer";
import { SnippetList } from "@plakk/ui/components/SnippetList";
import { LocalUploadSnippetRow, PublishedSnippetRow } from "@plakk/ui/components/SnippetRow";
import { Button } from "@plakk/ui/components/primitives/button";
import * as DateTime from "effect/DateTime";
import * as Schema from "effect/Schema";
import { useEffect, useRef, useState, type ClipboardEvent, type DragEvent } from "react";

import type { AccountProductState } from "./account-product-lifetime.ts";
import { WebSnippetActionError, type WebSnippetCopyOutcome } from "./snippet-actions.ts";
import type { WebProductContextValue } from "./web-product-context.tsx";

const storageProviderLabel = {
  DROPBOX: "Dropbox",
  GOOGLE_DRIVE: "Google Drive",
  ONE_DRIVE: "OneDrive",
} as const satisfies Record<StorageProviderStatus["storageProvider"], string>;

const trialEndDate = (trialEndsAt: DateTime.Utc) =>
  DateTime.formatUtc(trialEndsAt, {
    dateStyle: "long",
    locale: "en",
    timeStyle: "short",
  });

export function HomeView(props: {
  readonly user: User;
  readonly state: AccountProductState;
  readonly onRetry: (() => void) | null;
  readonly onSignOut: () => void;
  readonly signOutError: "product-purge" | "workos" | null;
  readonly onAddFiles: (files: ReadonlyArray<File>) => void;
  readonly onAddText: (text: string) => void;
  readonly onDismissUpload: (id: string) => void;
  readonly onBilling?: () => void;
  readonly onSettings?: () => void;
  readonly onStorageReconnect?: () => void;
  readonly snippetActions?: WebProductContextValue["snippetActions"];
  readonly uploadsDisabled: boolean;
}) {
  const {
    onAddFiles,
    onAddText,
    onDismissUpload,
    onBilling,
    onRetry,
    onSettings,
    onSignOut,
    onStorageReconnect,
    signOutError,
    snippetActions = null,
    state,
    uploadsDisabled,
    user,
  } = props;
  const [isDragging, setIsDragging] = useState(false);
  const [pendingExternalLink, setPendingExternalLink] = useState<{
    readonly snippet: ApiSnippet;
    readonly url: string;
  } | null>(null);
  const [rowActions, setRowActions] = useState<
    Readonly<
      Record<
        string,
        {
          readonly message?: string;
          readonly status: "busy" | "copied" | "idle" | "notice";
        }
      >
    >
  >({});
  const copiedTimers = useRef(new Map<string, number>());
  const now = DateTime.toEpochMillis(DateTime.nowUnsafe());
  const storageProvider = state.kind === "ready" ? state.account.storageProvider : null;
  const remoteActionsAvailable =
    state.kind === "ready" && state.apiAvailability === "available" && snippetActions !== null;
  const productActionsDisabled =
    !remoteActionsAvailable || state.kind !== "ready" || !accountCanSync(state.account);
  const deleteDisabled = !remoteActionsAvailable;

  useEffect(() => {
    if (productActionsDisabled) setPendingExternalLink(null);
  }, [productActionsDisabled]);

  useEffect(
    () => () => {
      for (const timer of copiedTimers.current.values()) window.clearTimeout(timer);
      copiedTimers.current.clear();
    },
    [],
  );

  const clearCopiedTimer = (id: string) => {
    const timer = copiedTimers.current.get(id);
    if (timer !== undefined) window.clearTimeout(timer);
    copiedTimers.current.delete(id);
  };
  const publishRowAction = (
    id: string,
    action: {
      readonly message?: string;
      readonly status: "busy" | "copied" | "idle" | "notice";
    },
  ) => {
    clearCopiedTimer(id);
    setRowActions((current) => ({ ...current, [id]: action }));
  };
  const clearRowAction = (id: string) => {
    clearCopiedTimer(id);
    setRowActions((current) => {
      const { [id]: _removed, ...remaining } = current;
      return remaining;
    });
  };
  const scheduleCopiedReset = (id: string) => {
    copiedTimers.current.set(
      id,
      window.setTimeout(() => {
        copiedTimers.current.delete(id);
        setRowActions((current) => {
          if (current[id]?.status !== "copied") return current;
          const { [id]: _removed, ...remaining } = current;
          return remaining;
        });
      }, 1_200),
    );
  };
  const rowActionError = (id: string, cause: unknown, fallback: string) => {
    const message =
      cause instanceof WebSnippetActionError
        ? cause.message
        : Schema.is(RpcError)(cause)
          ? cause.code === "FORBIDDEN"
            ? cause.message
            : cause.code === "NOT_FOUND"
              ? "This snippet is no longer available."
              : fallback
          : fallback;
    publishRowAction(id, {
      message,
      status: "notice",
    });
  };
  const copySnippet = async (snippet: ApiSnippet) => {
    if (snippetActions === null || productActionsDisabled) return;
    publishRowAction(snippet.id, { status: "busy" });
    try {
      const outcome: WebSnippetCopyOutcome = await snippetActions.copy(snippet);
      publishRowAction(
        snippet.id,
        outcome.kind === "COPIED"
          ? { message: "Copied", status: "copied" }
          : outcome.kind === "DOWNLOADED_IMAGE_FALLBACK"
            ? {
                message: "Image Copy is unavailable in this browser. Downloaded instead.",
                status: "notice",
              }
            : {
                message: "This content is not decodable text. Downloaded instead.",
                status: "notice",
              },
      );
      if (outcome.kind === "COPIED") scheduleCopiedReset(snippet.id);
    } catch (cause) {
      rowActionError(snippet.id, cause, "Plakk couldn’t fetch this snippet. Try again.");
    }
  };
  const downloadSnippet = async (snippet: ApiSnippet) => {
    if (snippetActions === null || productActionsDisabled) return;
    publishRowAction(snippet.id, { status: "busy" });
    try {
      await snippetActions.download(snippet);
      publishRowAction(snippet.id, { message: "Downloaded", status: "notice" });
    } catch (cause) {
      rowActionError(snippet.id, cause, "Plakk couldn’t fetch this snippet. Try again.");
    }
  };
  const prepareOpenSnippet = async (snippet: ApiSnippet) => {
    if (snippetActions === null || productActionsDisabled) return;
    publishRowAction(snippet.id, { status: "busy" });
    try {
      const { url } = await snippetActions.prepareOpen(snippet);
      publishRowAction(snippet.id, { status: "idle" });
      setPendingExternalLink({ snippet, url });
    } catch (cause) {
      rowActionError(snippet.id, cause, "Plakk couldn’t fetch this snippet. Try again.");
    }
  };
  const confirmExternalLink = async () => {
    const pending = pendingExternalLink;
    if (pending === null || snippetActions === null || productActionsDisabled) return;
    setPendingExternalLink(null);
    publishRowAction(pending.snippet.id, { status: "busy" });
    try {
      await snippetActions.open(pending.url);
      publishRowAction(pending.snippet.id, { status: "idle" });
    } catch (cause) {
      rowActionError(pending.snippet.id, cause, "Plakk couldn’t open this link. Try again.");
    }
  };
  const deleteSnippet = async (snippet: ApiSnippet) => {
    if (snippetActions === null || deleteDisabled) return;
    publishRowAction(snippet.id, { status: "busy" });
    try {
      await snippetActions.delete(snippet.id);
      clearRowAction(snippet.id);
    } catch (cause) {
      rowActionError(snippet.id, cause, "Plakk couldn’t delete this snippet. Try again.");
    }
  };

  const addDroppedFiles = (event: DragEvent<HTMLElement>) => {
    event.preventDefault();
    setIsDragging(false);
    if (!uploadsDisabled && event.dataTransfer.files.length > 0) {
      onAddFiles(Array.from(event.dataTransfer.files));
    }
  };
  const addPastedContent = (event: ClipboardEvent<HTMLElement>) => {
    if (uploadsDisabled) return;
    if (
      event.target instanceof Element &&
      event.target.closest(
        "input, textarea, select, [contenteditable]:not([contenteditable='false'])",
      ) !== null
    ) {
      return;
    }
    const files = Array.from(event.clipboardData.files);
    if (files.length > 0) {
      event.preventDefault();
      onAddFiles(files);
      return;
    }
    const text = event.clipboardData.getData("text/plain").trim();
    if (text !== "") {
      event.preventDefault();
      onAddText(text);
    }
  };

  return (
    <main
      className="relative flex min-h-screen flex-col bg-background text-foreground"
      aria-label="Plakk"
      onDragEnter={(event) => {
        if (!uploadsDisabled && event.dataTransfer.types.includes("Files")) {
          event.preventDefault();
          setIsDragging(true);
        }
      }}
      onDragOver={(event) => {
        if (!uploadsDisabled && event.dataTransfer.types.includes("Files")) {
          event.preventDefault();
        }
      }}
      onDragLeave={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget as Node | null)) {
          setIsDragging(false);
        }
      }}
      onDrop={addDroppedFiles}
      onPaste={addPastedContent}
    >
      <AppHeader
        className="h-14 border-b border-border"
        user={user}
        onSignOutClick={onSignOut}
        {...(onSettings === undefined ? {} : { onSettingsClick: onSettings })}
        storageAction={
          <span className="text-xs text-muted-foreground">
            {storageProvider === null ? "Web · Read only" : storageProviderLabel[storageProvider]}
          </span>
        }
      />
      {isDragging && (
        <div
          className="pointer-events-none absolute inset-3 z-20 grid place-items-center rounded-xl border-2 border-dashed border-primary bg-background/90 text-sm font-medium"
          role="status"
        >
          Drop files to publish
        </div>
      )}

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

        {!uploadsDisabled && (
          <SnippetComposer
            className="mb-6"
            onFiles={(files) => onAddFiles(Array.from(files))}
            onSubmit={onAddText}
          />
        )}

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
            <div
              className="mb-4 flex flex-wrap items-center justify-between gap-3 rounded-lg border border-amber-500/30 bg-amber-500/10 px-4 py-3 text-sm"
              role="status"
            >
              <p className="text-muted-foreground">
                <strong className="font-medium text-foreground">Trial active.</strong> Your account
                trial ends exactly {trialEndDate(state.account.accessEntitlement.trialEndsAt)}.{" "}
                <strong className="text-foreground">Billing starts immediately.</strong> Subscribing
                permanently ends any unused trial time.
              </p>
              {onBilling !== undefined && (
                <Button type="button" size="sm" onClick={onBilling}>
                  Upgrade
                </Button>
              )}
            </div>
          ) : state.account.accessEntitlement.status === "PAID_ACTIVE" ? (
            <div
              className="mb-4 flex flex-wrap items-center justify-between gap-3 rounded-lg border border-border bg-muted/40 px-4 py-3 text-sm text-muted-foreground"
              role="status"
            >
              <p>
                <strong className="font-medium text-foreground">
                  {state.account.accessEntitlement.cancelAtPeriodEnd
                    ? "Subscription canceled."
                    : "Paid access active."}
                </strong>{" "}
                Access continues through {trialEndDate(state.account.accessEntitlement.paidThrough)}
                .
              </p>
              {onBilling !== undefined && (
                <Button type="button" variant="outline" size="sm" onClick={onBilling}>
                  Manage billing
                </Button>
              )}
            </div>
          ) : state.account.accessEntitlement.status === "GRACE_ACTIVE" ? (
            <div
              className="mb-4 flex flex-wrap items-center justify-between gap-3 rounded-lg border border-destructive/20 bg-destructive/10 px-4 py-3 text-sm text-destructive"
              role="alert"
            >
              <p>
                <strong>Payment needs attention.</strong> Normal use continues through{" "}
                {trialEndDate(state.account.accessEntitlement.graceEndsAt)}. Recover billing before
                grace expires.
              </p>
              {onBilling !== undefined && (
                <Button type="button" size="sm" onClick={onBilling}>
                  Recover billing
                </Button>
              )}
            </div>
          ) : (
            <div
              className="mb-4 flex flex-wrap items-center justify-between gap-3 rounded-lg border border-destructive/20 bg-destructive/10 px-4 py-3 text-sm text-destructive"
              role="alert"
            >
              <p>
                <strong>Billing access required.</strong> Your snippets are preserved. Restore
                billing access to resume normal use. Add, Copy, Download, and Open remain
                unavailable.
              </p>
              {onBilling !== undefined && (
                <Button type="button" size="sm" onClick={onBilling}>
                  Restore billing
                </Button>
              )}
            </div>
          ))}

        {state.kind === "ready" && state.account.blockedReasons.includes("storage") && (
          <div
            className="mb-4 rounded-lg border border-destructive/20 bg-destructive/10 px-4 py-3 text-sm text-destructive"
            role="alert"
          >
            <strong>Storage access required.</strong> Your snippets remain visible. Reconnect
            storage to resume Copy, Download, and Open. Delete remains available.
            {onStorageReconnect !== undefined && (
              <Button
                type="button"
                variant="outline"
                size="sm"
                className="ml-3"
                onClick={onStorageReconnect}
              >
                Reconnect storage
              </Button>
            )}
          </div>
        )}

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
              {state.snippets.map((record) => {
                if (record.kind === "PUBLISHED") {
                  return (
                    <PublishedSnippetRow
                      key={`published:${record.snippet.id}`}
                      snippet={record.snippet}
                      presentation={deriveSnippetPresentation({
                        fileName: record.snippet.fileName,
                      })}
                      now={now}
                      deleteDisabled={deleteDisabled}
                      productActionsDisabled={productActionsDisabled}
                      {...(rowActions[record.snippet.id] === undefined
                        ? {}
                        : {
                            actionStatus: rowActions[record.snippet.id].status,
                            ...(rowActions[record.snippet.id].message === undefined
                              ? {}
                              : { actionMessage: rowActions[record.snippet.id].message }),
                          })}
                      {...(snippetActions === null
                        ? {}
                        : {
                            onCopy: () => void copySnippet(record.snippet),
                            onDelete: () => void deleteSnippet(record.snippet),
                            onDownload: () => void downloadSnippet(record.snippet),
                            onOpenLink: () => void prepareOpenSnippet(record.snippet),
                          })}
                    />
                  );
                }
                return (
                  <LocalUploadSnippetRow
                    key={`local:${record.id}`}
                    snippet={record}
                    presentation={deriveSnippetPresentation({ fileName: record.fileName })}
                    now={now}
                    onDismiss={() => onDismissUpload(record.id)}
                  />
                );
              })}
            </SnippetList>
          </>
        )}
      </div>

      <ExternalLinkConfirmationDialog
        description="This link will open in a new browser tab."
        open={pendingExternalLink !== null}
        url={pendingExternalLink?.url ?? null}
        onCancel={() => {
          setPendingExternalLink(null);
        }}
        onConfirm={() => void confirmExternalLink()}
      />
    </main>
  );
}
