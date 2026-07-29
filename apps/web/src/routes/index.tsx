import type { ClientCapability } from "@plakk/shared/PlakkApi";
import {
  STORAGE_PROVIDERS,
  decodeSnippetText,
  isTextSnippetFileName,
  type StorageProvider,
  type User,
} from "@plakk/shared";
import { accountCanSyncWithConnection } from "@plakk/shared/PlakkApi";
import { AppHeader } from "@plakk/ui/components/AppHeader";
import { ProductNotice } from "@plakk/ui/components/ProductNotice";
import { Settings as SettingsUI } from "@plakk/ui/components/settings";
import { SnippetComposer } from "@plakk/ui/components/SnippetComposer";
import { SnippetList } from "@plakk/ui/components/SnippetList";
import { SnippetRow } from "@plakk/ui/components/SnippetRow";
import { SyncStatusIndicator, type SyncStatus } from "@plakk/ui/components/SyncStatusIndicator";
import { getInitials } from "@plakk/ui/lib/getInitials";
import { Avatar, AvatarFallback } from "@plakk/ui/primitives/avatar";
import { Button } from "@plakk/ui/primitives/button";
import { Dialog, DialogContent, DialogTitle } from "@plakk/ui/primitives/dialog";
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@plakk/ui/primitives/empty";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@plakk/ui/primitives/select";
import { useHotkey } from "@tanstack/react-hotkeys";
import { createFileRoute, redirect } from "@tanstack/react-router";
import { getAuth, type User as AuthKitUser } from "@workos/authkit-tanstack-react-start";
import * as DateTime from "effect/DateTime";
import { Effect, Stream } from "effect";
import {
  ArrowUpRight,
  CircleAlert,
  CloudOff,
  CreditCard,
  LoaderCircle,
  MessageCircle,
  PanelsTopLeft,
  Plus,
  SunMoon,
} from "lucide-react";
import { useEffect, useRef, useState } from "react";

import { StorageProviderIcon, storageProviderLabel } from "../components/StorageProviderIcon.tsx";
import { useClientRuntime, type ClientRuntimeIssue } from "../hooks/useClientRuntime.ts";
import { useSnippets, type SnippetReadModel } from "../hooks/useSnippets.ts";
import { useTheme, type Theme } from "../hooks/useTheme.tsx";
import { downloadFile, sweepTemporaryDownloads } from "../lib/browserDownloads.ts";
import { productFailureFrom, type ProductFailure } from "../lib/productFailure.ts";
import { storageState } from "../lib/storageState.ts";
import { collectBytes } from "../runtime/client.ts";

const BUFFERED_CONTENT_MAX_BYTES = 64 * 1024 * 1024;
const offlineCapability: ClientCapability = {
  status: "OFFLINE",
  storageProvider: { known: false, value: null },
};

const actionFailures = {
  addSnippet: {
    title: "Couldn’t add this snippet",
    description: "Nothing was added. Try again with content under 64 MiB.",
  },
  addFiles: {
    title: "Couldn’t add these files",
    description: "Nothing was added. Choose the files again and retry.",
  },
  connectStorage: {
    title: "Couldn’t connect storage",
    description: "Your storage setup was not changed. Try again.",
  },
  copySnippet: {
    title: "Couldn’t copy this snippet",
    description: "Your clipboard was not changed. Try again.",
  },
  downloadSnippet: {
    title: "Couldn’t download this snippet",
    description: "No file was saved. Try again.",
  },
  removeSnippet: {
    title: "Couldn’t remove this snippet",
    description: "The snippet is still in your list. Try again.",
  },
  signOut: {
    title: "Couldn’t sign out",
    description: "You are still signed in. Try again.",
  },
} satisfies Record<string, ProductFailure>;

const runtimeIssuePresentation: Record<ClientRuntimeIssue, ProductFailure> = {
  "another-tab": {
    title: "Plakk is open in another tab",
    description: "Keep using Plakk there, or close that tab and check again here.",
  },
  session: {
    title: "Couldn’t verify your session",
    description: "Check your connection and try again. Sign in again if the problem continues.",
  },
  startup: {
    title: "Plakk couldn’t start in this tab",
    description:
      "Reload this tab and try again. Your snippets in connected storage are still safe.",
  },
};

function RuntimeIssueState({
  issue,
  onRetry,
}: {
  readonly issue: ClientRuntimeIssue;
  readonly onRetry: () => Promise<void>;
}) {
  const presentation = runtimeIssuePresentation[issue];
  const anotherTab = issue === "another-tab";
  const [isChecking, setIsChecking] = useState(false);
  const retryTimer = useRef<number | null>(null);

  useEffect(
    () => () => {
      if (retryTimer.current !== null) window.clearTimeout(retryTimer.current);
    },
    [],
  );

  const handleRetry = () => {
    if (!anotherTab) {
      void onRetry();
      return;
    }

    setIsChecking(true);
    retryTimer.current = window.setTimeout(() => {
      retryTimer.current = null;
      void onRetry().finally(() => setIsChecking(false));
    }, 1_000);
  };

  return (
    <Empty
      role={anotherTab ? "status" : "alert"}
      aria-live={anotherTab ? "polite" : undefined}
      className="gap-5 p-0"
    >
      <EmptyHeader>
        <EmptyMedia
          variant="icon"
          className={
            anotherTab
              ? "size-10 rounded-full bg-amber-500/10 text-amber-500"
              : "size-10 rounded-full bg-destructive/10 text-destructive"
          }
        >
          {anotherTab ? <PanelsTopLeft /> : <CircleAlert />}
        </EmptyMedia>
        <EmptyTitle className="text-base">{presentation.title}</EmptyTitle>
        <EmptyDescription>{presentation.description}</EmptyDescription>
      </EmptyHeader>
      <EmptyContent>
        <Button
          type="button"
          variant="outline"
          size="sm"
          disabled={isChecking}
          onClick={handleRetry}
        >
          {isChecking && <LoaderCircle className="animate-spin" aria-hidden="true" />}
          {isChecking ? "Checking…" : anotherTab ? "Check again" : "Try again"}
        </Button>
      </EmptyContent>
    </Empty>
  );
}

function SnippetRowSkeleton() {
  return (
    <li aria-hidden="true">
      <div className="flex items-center gap-2.5 px-2 py-2">
        <span className="size-8 shrink-0 animate-pulse rounded-md bg-muted" />
        <div className="grid flex-1 gap-1.5">
          <span className="h-3.5 w-32 animate-pulse rounded bg-muted" />
          <span className="h-3 w-24 animate-pulse rounded bg-muted" />
        </div>
      </div>
    </li>
  );
}

const {
  Row: SettingsRow,
  RowIcon: SettingsRowIcon,
  RowMain: SettingsRowMain,
  RowText: SettingsRowText,
  Section: SettingsSection,
  SectionBody: SettingsSectionBody,
  SectionTitle: SettingsSectionTitle,
} = SettingsUI;

const toUser = (user: AuthKitUser): User => ({
  id: user.id,
  firstName: user.firstName,
  lastName: user.lastName,
  email: user.email,
  createdAt: user.createdAt,
  updatedAt: user.updatedAt,
});

function IndexRoute() {
  const { user: initialUser } = Route.useLoaderData();
  const user = toUser(initialUser);
  const runtime = useClientRuntime(user);
  const snippets = useSnippets(runtime);
  const { theme, setTheme } = useTheme();
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [isDragging, setIsDragging] = useState(false);
  const [actionError, setActionError] = useState<ProductFailure | null>(null);
  const [storageError, setStorageError] = useState<ProductFailure | null>(null);
  const [copiedId, setCopiedId] = useState<string | null>(null);
  const [copyingId, setCopyingId] = useState<string | null>(null);
  const [now, setNow] = useState(() => DateTime.toEpochMillis(DateTime.nowUnsafe()));
  const [offlineConfirmed, setOfflineConfirmed] = useState(false);
  const copiedTimer = useRef<number | undefined>(undefined);
  const capability = runtime.snapshot?.capability ?? offlineCapability;
  const storage = storageState(capability);
  const blocked = storage.kind !== "connected" || !storage.canSync;
  const billingBlocked =
    capability.status === "ONLINE" && capability.account.blockedReasons.includes("billing");
  const provider =
    capability.status === "ONLINE" &&
    accountCanSyncWithConnection(capability.account, capability.connection)
      ? capability.account.storageProvider
      : null;

  useHotkey({ key: ",", mod: true }, () => setSettingsOpen(true));
  useHotkey("Escape", () => setSettingsOpen(false), { enabled: settingsOpen });

  useEffect(() => {
    void sweepTemporaryDownloads().catch(() => {});
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

  useEffect(() => {
    if (runtime.loading || capability.status !== "OFFLINE") {
      setOfflineConfirmed(false);
      return;
    }
    const timer = window.setTimeout(() => setOfflineConfirmed(true), 1_000);
    return () => window.clearTimeout(timer);
  }, [capability.status, runtime.loading]);

  const openExternal = (url: string) => window.open(url, "_blank", "noopener,noreferrer");
  const runAction = (operation: Promise<void>, fallback: ProductFailure) => {
    setActionError(null);
    void operation.catch((cause) => setActionError(productFailureFrom(cause, fallback)));
  };
  const connectStorage = async (storageProvider: StorageProvider) => {
    const url = await runtime.run((client) => client.storage.beginLink(storageProvider));
    window.location.assign(url);
  };
  const addText = async (text: string) => {
    if (provider === null) throw new Error("Connect storage before adding snippets.");
    const bytes = new TextEncoder().encode(text);
    if (bytes.byteLength > BUFFERED_CONTENT_MAX_BYTES) {
      throw new Error("Web snippets cannot be larger than 64 MiB.");
    }
    const id = crypto.randomUUID();
    await runtime.run((client) =>
      client.uploads.upload(
        {
          id,
          fileName: `${id}.txt`,
          byteSize: bytes.byteLength,
          mediaType: "text/plain; charset=utf-8",
          storageProvider: provider,
        },
        {
          read: (offset, byteSize) => Effect.succeed(bytes.slice(offset, offset + byteSize)),
        },
      ),
    );
  };
  const addFiles = async (files: ReadonlyArray<File>) => {
    if (provider === null) throw new Error("Connect storage before adding snippets.");
    await Promise.all(
      files.map((file) =>
        runtime.run((client) =>
          client.uploads.upload(
            {
              id: crypto.randomUUID(),
              fileName: file.name,
              byteSize: file.size,
              mediaType: file.type || null,
              storageProvider: provider,
            },
            {
              read: (offset, byteSize) =>
                Effect.tryPromise(() =>
                  file
                    .slice(offset, offset + byteSize)
                    .arrayBuffer()
                    .then((buffer) => new Uint8Array(buffer)),
                ),
            },
          ),
        ),
      ),
    );
  };
  const deleteSnippet = (snippet: SnippetReadModel) =>
    runtime.run((client) =>
      snippet.kind === "LOCAL"
        ? client.snippets.dismissFailedUpload(snippet.id)
        : client.snippets.delete(snippet.id),
    );
  const copySnippet = async (snippet: SnippetReadModel) => {
    if (!isTextSnippetFileName(snippet.fileName)) {
      throw new Error("This snippet is not ready to copy.");
    }
    if (snippet.byteSize > BUFFERED_CONTENT_MAX_BYTES) {
      throw new Error("This snippet is too large to open in the browser.");
    }
    const content = runtime
      .run((client) => collectBytes(client.content.readRemote(snippet.id)))
      .then((bytes) => {
        const decoded = decodeSnippetText(bytes);
        if (decoded === null) throw new Error("This snippet is not valid UTF-8 text.");
        return new Blob([decoded], { type: "text/plain" });
      });
    await navigator.clipboard.write([new ClipboardItem({ "text/plain": content })]);
  };
  const copy = (snippet: SnippetReadModel) => {
    setCopyingId(snippet.id);
    void copySnippet(snippet)
      .then(
        () => {
          setCopiedId(snippet.id);
          if (copiedTimer.current !== undefined) window.clearTimeout(copiedTimer.current);
          copiedTimer.current = window.setTimeout(() => setCopiedId(null), 1_200);
        },
        (cause) => setActionError(productFailureFrom(cause, actionFailures.copySnippet)),
      )
      .finally(() => setCopyingId(null));
  };
  const downloadSnippet = (snippet: SnippetReadModel) =>
    downloadFile(snippet.fileName, (write) =>
      runtime.run((client) =>
        client.content
          .readRemote(snippet.id)
          .pipe(
            Stream.runForEach((chunk) => Effect.tryPromise(() => write(Uint8Array.from(chunk)))),
          ),
      ),
    );
  const fallback = user.email ?? user.id;
  const name = [user.firstName, user.lastName].filter(Boolean).join(" ") || fallback;
  const settingsDialog = (
    <Dialog
      open={settingsOpen}
      onOpenChange={(open) => {
        setSettingsOpen(open);
      }}
    >
      <DialogContent className="max-h-[calc(100dvh-2rem)] overflow-y-auto p-6 sm:max-w-2xl">
        <DialogTitle className="sr-only">Settings</DialogTitle>
        <div className="grid gap-6">
          <SettingsSection>
            <SettingsSectionTitle>Account</SettingsSectionTitle>
            <SettingsSectionBody>
              <SettingsRow className="px-4">
                <SettingsRowMain>
                  <Avatar className="size-10">
                    <AvatarFallback className="text-sm font-medium">
                      {getInitials(name, fallback)}
                    </AvatarFallback>
                  </Avatar>
                  <SettingsRowText
                    title={name}
                    description={name === fallback ? undefined : fallback}
                  />
                </SettingsRowMain>
                <span className="rounded-full bg-muted px-2 py-1 text-[11px] leading-none font-medium text-muted-foreground">
                  Pro
                </span>
              </SettingsRow>
              <SettingsRow className="px-4">
                <SettingsRowMain>
                  <SettingsRowIcon>
                    <CreditCard className="size-4 text-muted-foreground" aria-hidden="true" />
                  </SettingsRowIcon>
                  <SettingsRowText title="Plakk Pro" description="Current plan" />
                </SettingsRowMain>
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  onClick={() => openExternal("https://app.plakk.io/billing")}
                >
                  Manage
                  <ArrowUpRight />
                </Button>
              </SettingsRow>
              <SettingsRow className="px-4">
                <SettingsRowMain>
                  <SettingsRowIcon>
                    {storage.kind === "unlinked" || storage.kind === "offline" ? (
                      <CloudOff className="size-4 text-muted-foreground" aria-hidden="true" />
                    ) : (
                      <StorageProviderIcon provider={storage.provider} className="size-5" />
                    )}
                  </SettingsRowIcon>
                  <SettingsRowText
                    title={
                      storage.kind === "connected"
                        ? `${storageProviderLabel(storage.provider)} connected`
                        : storage.kind === "reauthorize"
                          ? `${storageProviderLabel(storage.provider)} needs reconnection`
                          : storage.kind === "offline" && storage.provider !== null
                            ? `${storageProviderLabel(storage.provider)} linked`
                            : storage.kind === "unavailable"
                              ? "Storage status unavailable"
                              : "Storage not linked"
                    }
                    description={
                      storage.kind === "connected"
                        ? storage.canSync
                          ? "Syncing snippets to this storage provider."
                          : "Sync is currently paused."
                        : storage.kind === "offline"
                          ? "Offline — showing the last confirmed storage provider."
                          : "Connect storage to sync snippets."
                    }
                  />
                </SettingsRowMain>
                {storage.kind === "connected" ? (
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    onClick={() => openExternal(storage.destinationUrl)}
                  >
                    Open
                    <ArrowUpRight />
                  </Button>
                ) : storage.kind === "unlinked" ||
                  (storage.kind === "offline" && storage.provider === null) ? (
                  <div className="flex items-center gap-1">
                    {STORAGE_PROVIDERS.map((storageProvider) => (
                      <Button
                        key={storageProvider}
                        type="button"
                        variant="ghost"
                        size="icon-sm"
                        toolTip={`Connect ${storageProviderLabel(storageProvider)}`}
                        onClick={() => {
                          setStorageError(null);
                          void connectStorage(storageProvider).catch((cause) =>
                            setStorageError(
                              productFailureFrom(cause, actionFailures.connectStorage),
                            ),
                          );
                        }}
                      >
                        <StorageProviderIcon provider={storageProvider} className="size-5" />
                        <span className="sr-only">
                          Connect {storageProviderLabel(storageProvider)}
                        </span>
                      </Button>
                    ))}
                  </div>
                ) : (
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    onClick={() => {
                      if (storage.provider === null) return;
                      setStorageError(null);
                      void connectStorage(storage.provider).catch((cause) =>
                        setStorageError(productFailureFrom(cause, actionFailures.connectStorage)),
                      );
                    }}
                  >
                    {storage.kind === "reauthorize" ? "Reconnect" : "Connect"}
                    <ArrowUpRight />
                  </Button>
                )}
              </SettingsRow>
              {storageError !== null && (
                <ProductNotice className="mx-4 mb-3" tone="danger" title={storageError.title}>
                  {storageError.description}
                </ProductNotice>
              )}
            </SettingsSectionBody>
          </SettingsSection>
          <SettingsSection>
            <SettingsSectionTitle>Appearance</SettingsSectionTitle>
            <SettingsSectionBody>
              <SettingsRow>
                <SettingsRowMain>
                  <SunMoon className="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
                  <SettingsRowText
                    title="Appearance"
                    description="Choose a theme or follow your system."
                  />
                </SettingsRowMain>
                <Select
                  value={theme}
                  onValueChange={(value) => {
                    if (value === "light" || value === "dark" || value === "system") {
                      setTheme(value satisfies Theme);
                    }
                  }}
                >
                  <SelectTrigger aria-label="Appearance">
                    <SelectValue>
                      {theme === "system" ? "System" : theme === "dark" ? "Dark" : "Light"}
                    </SelectValue>
                  </SelectTrigger>
                  <SelectContent align="end">
                    <SelectGroup>
                      <SelectItem value="light">Light</SelectItem>
                      <SelectItem value="dark">Dark</SelectItem>
                      <SelectItem value="system">System</SelectItem>
                    </SelectGroup>
                  </SelectContent>
                </Select>
              </SettingsRow>
            </SettingsSectionBody>
          </SettingsSection>
          <SettingsSection>
            <SettingsSectionTitle>Help</SettingsSectionTitle>
            <SettingsSectionBody>
              {[
                ["Contact us", "Get help from the Plakk team.", "https://app.plakk.io/contact"],
                [
                  "Give feedback",
                  "Share what is working or missing.",
                  "https://app.plakk.io/feedback",
                ],
              ].map(([title, description, url]) => (
                <SettingsRow key={title}>
                  <SettingsRowMain>
                    <MessageCircle
                      className="size-4 shrink-0 text-muted-foreground"
                      aria-hidden="true"
                    />
                    <SettingsRowText title={title!} description={description} />
                  </SettingsRowMain>
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    onClick={() => openExternal(url!)}
                  >
                    Open
                  </Button>
                </SettingsRow>
              ))}
            </SettingsSectionBody>
          </SettingsSection>
        </div>
      </DialogContent>
    </Dialog>
  );

  const syncStatus: SyncStatus =
    runtime.issue !== null
      ? "PAUSED"
      : runtime.loading || (capability.status === "OFFLINE" && !offlineConfirmed)
        ? "CHECKING"
        : capability.status === "OFFLINE"
          ? "OFFLINE"
          : blocked
            ? "PAUSED"
            : runtime.snapshot?.syncStatus === "CONNECTED"
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
        if (files.length > 0) runAction(addFiles(files), actionFailures.addFiles);
        else {
          const text = event.clipboardData.getData("text/plain").trim();
          if (text) runAction(addText(text), actionFailures.addSnippet);
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
        if (files.length > 0) runAction(addFiles(files), actionFailures.addFiles);
        else {
          const text = event.dataTransfer.getData("text/plain").trim();
          if (text) runAction(addText(text), actionFailures.addSnippet);
        }
      }}
    >
      <div className="mx-auto flex w-full max-w-3xl flex-1 flex-col">
        <AppHeader
          className="mt-3"
          user={user}
          onSettingsClick={() => setSettingsOpen(true)}
          onSignOutClick={() => runAction(runtime.signOut(), actionFailures.signOut)}
          statusIndicator={<SyncStatusIndicator status={syncStatus} />}
          storageAction={
            storage.kind === "connected" ? (
              <Button
                type="button"
                variant="ghost"
                size="sm"
                aria-label={`Open ${storageProviderLabel(storage.provider)} in browser`}
                toolTip={`Open ${storageProviderLabel(storage.provider)}`}
                onClick={() => openExternal(storage.destinationUrl)}
              >
                <StorageProviderIcon provider={storage.provider} className="size-4" />
                {storageProviderLabel(storage.provider)}
                <ArrowUpRight className="text-muted-foreground" />
              </Button>
            ) : null
          }
        />
        <div className="flex min-h-0 flex-1 flex-col px-6 pb-6">
          {runtime.issue !== null ? (
            <RuntimeIssueState issue={runtime.issue} onRetry={runtime.refresh} />
          ) : (
            <>
              <div className="sticky top-0 z-20 bg-background pt-5 pb-4">
                {blocked && !runtime.loading && capability.status === "ONLINE" && (
                  <ProductNotice
                    className="mb-2"
                    tone="warning"
                    action={
                      <Button
                        type="button"
                        variant="ghost"
                        size="xs"
                        onClick={() =>
                          billingBlocked
                            ? openExternal("https://app.plakk.io/billing")
                            : setSettingsOpen(true)
                        }
                      >
                        {billingBlocked ? "Manage billing" : "Finish setup"}
                      </Button>
                    }
                  >
                    {billingBlocked
                      ? "Sync is paused until billing is resolved."
                      : "Sync is paused until account storage is ready."}
                  </ProductNotice>
                )}
                <SnippetComposer.Root
                  disabled={blocked}
                  onSubmit={(text) => runAction(addText(text), actionFailures.addSnippet)}
                >
                  <SnippetComposer.Input />
                  <SnippetComposer.Attachment>
                    <input
                      multiple
                      onChange={(event) => {
                        if (event.currentTarget.files?.length) {
                          runAction(
                            addFiles(Array.from(event.currentTarget.files)),
                            actionFailures.addFiles,
                          );
                        }
                        event.currentTarget.value = "";
                      }}
                    />
                  </SnippetComposer.Attachment>
                  <SnippetComposer.Submit />
                </SnippetComposer.Root>
                {actionError !== null && (
                  <ProductNotice className="mt-2" tone="danger" title={actionError.title}>
                    {actionError.description}
                  </ProductNotice>
                )}
              </div>
              <SnippetList.Root
                aria-busy={
                  snippets.isLoading ||
                  snippets.items.some((snippet) => snippet.presentation === null)
                }
              >
                <SnippetList.Heading />
                {snippets.isLoading && snippets.items.length === 0 ? (
                  <>
                    <span className="sr-only" role="status">
                      Loading snippets
                    </span>
                    <SnippetList.Items>
                      {Array.from({ length: 4 }, (_, index) => (
                        <SnippetRowSkeleton key={index} />
                      ))}
                    </SnippetList.Items>
                  </>
                ) : snippets.items.length === 0 ? (
                  <SnippetList.Empty />
                ) : (
                  <SnippetList.Items>
                    {snippets.items.map((snippet) =>
                      snippet.presentation === null ? (
                        <SnippetRowSkeleton key={snippet.id} />
                      ) : (
                        <SnippetRow
                          key={snippet.id}
                          snippet={snippet}
                          presentation={snippet.presentation}
                          thumbnailUrl={snippet.thumbnailUrl}
                          now={now}
                          copied={copiedId === snippet.id}
                          copying={copyingId === snippet.id}
                          copyDisabled={snippet.kind !== "PUBLISHED"}
                          onCopy={() => copy(snippet)}
                          onDelete={() =>
                            runAction(deleteSnippet(snippet), actionFailures.removeSnippet)
                          }
                          onDownload={() =>
                            runAction(downloadSnippet(snippet), actionFailures.downloadSnippet)
                          }
                          onOpenLink={openExternal}
                          contentMode="remote"
                        />
                      ),
                    )}
                  </SnippetList.Items>
                )}
              </SnippetList.Root>
            </>
          )}
        </div>
      </div>
      {settingsDialog}
      {isDragging && (
        <div className="pointer-events-none fixed inset-0 z-50 flex items-center justify-center bg-blue-500/15">
          <div className="flex size-8 items-center justify-center rounded-full bg-blue-500 text-white shadow-sm">
            <Plus className="size-5" />
          </div>
        </div>
      )}
    </main>
  );
}

export const Route = createFileRoute("/")({
  loader: async () => {
    const { user } = await getAuth();
    if (user === null) throw redirect({ href: "/api/auth/sign-in" });
    return { user };
  },
  component: IndexRoute,
});
