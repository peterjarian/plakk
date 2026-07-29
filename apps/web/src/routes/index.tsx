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
import { Settings as SettingsUI } from "@plakk/ui/components/settings";
import { SnippetComposer } from "@plakk/ui/components/SnippetComposer";
import { SnippetList } from "@plakk/ui/components/SnippetList";
import { SnippetRow } from "@plakk/ui/components/SnippetRow";
import { getInitials } from "@plakk/ui/lib/getInitials";
import { Avatar, AvatarFallback } from "@plakk/ui/primitives/avatar";
import { Button } from "@plakk/ui/primitives/button";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@plakk/ui/primitives/select";
import { createFileRoute, getRouteApi } from "@tanstack/react-router";
import type { User as AuthKitUser } from "@workos/authkit-tanstack-react-start";
import * as DateTime from "effect/DateTime";
import { Effect, Stream } from "effect";
import {
  ArrowLeft,
  ArrowUpRight,
  CloudOff,
  CreditCard,
  LoaderCircle,
  MessageCircle,
  Plus,
  SunMoon,
  TriangleAlert,
} from "lucide-react";
import { useEffect, useRef, useState } from "react";

import { StorageProviderIcon, storageProviderLabel } from "../components/StorageProviderIcon.tsx";
import { SyncStatusIndicator, type SyncStatus } from "../components/SyncStatusIndicator.tsx";
import { useClientRuntime } from "../hooks/useClientRuntime.ts";
import { useSnippets, type SnippetReadModel } from "../hooks/useSnippets.ts";
import { useTheme, type Theme } from "../hooks/useTheme.tsx";
import { downloadFile, sweepTemporaryDownloads } from "../lib/browserDownloads.ts";
import { storageState } from "../lib/storageState.ts";
import { collectBytes } from "../runtime/client.ts";

const rootRoute = getRouteApi("__root__");
const BUFFERED_CONTENT_MAX_BYTES = 64 * 1024 * 1024;
const offlineCapability: ClientCapability = {
  status: "OFFLINE",
  storageProvider: { known: false, value: null },
};

const {
  Row: SettingsRow,
  RowIcon: SettingsRowIcon,
  RowMain: SettingsRowMain,
  RowText: SettingsRowText,
  Section: SettingsSection,
  SectionBody: SettingsSectionBody,
  SectionTitle: SettingsSectionTitle,
} = SettingsUI;

const messageFrom = (cause: unknown, fallback: string) =>
  cause instanceof Error && cause.message.trim() ? cause.message : fallback;

const toUser = (user: AuthKitUser | null): User | null =>
  user === null
    ? null
    : {
        id: user.id,
        firstName: user.firstName,
        lastName: user.lastName,
        email: user.email,
        createdAt: user.createdAt,
        updatedAt: user.updatedAt,
      };

function IndexRoute() {
  const { user: initialUser } = rootRoute.useLoaderData();
  const user = toUser(initialUser);
  const runtime = useClientRuntime(user);
  const snippets = useSnippets(runtime);
  const { theme, setTheme } = useTheme();
  const [screen, setScreen] = useState<"home" | "settings">("home");
  const [isDragging, setIsDragging] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const [storageError, setStorageError] = useState<string | null>(null);
  const [copiedId, setCopiedId] = useState<string | null>(null);
  const [copyingId, setCopyingId] = useState<string | null>(null);
  const [now, setNow] = useState(() => DateTime.toEpochMillis(DateTime.nowUnsafe()));
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

  const openExternal = (url: string) => window.open(url, "_blank", "noopener,noreferrer");
  const runAction = (operation: Promise<void>, fallback: string) => {
    setActionError(null);
    void operation.catch((cause) => setActionError(messageFrom(cause, fallback)));
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
    if (snippet.localTextPreview !== null) {
      await navigator.clipboard.writeText(snippet.localTextPreview);
      return;
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
        (cause) => setActionError(messageFrom(cause, "Could not copy this snippet.")),
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

  if (user === null) {
    return (
      <main className="grid min-h-screen place-items-center bg-background p-6 text-foreground">
        <section className="grid w-full max-w-md gap-5 text-center">
          <div className="grid gap-1">
            <p className="text-xs font-medium tracking-wide text-muted-foreground uppercase">
              Plakk
            </p>
            <h1 className="text-2xl leading-tight font-semibold">Move snippets between devices.</h1>
          </div>
          {runtime.error && <p className="text-xs text-destructive">{runtime.error}</p>}
          <Button
            type="button"
            className="h-10 w-full"
            disabled={runtime.loading}
            onClick={() => window.location.assign("/api/auth/sign-in")}
          >
            {runtime.loading ? "Checking session…" : "Sign in"}
            <ArrowUpRight />
          </Button>
        </section>
      </main>
    );
  }

  if (screen === "settings") {
    const fallback = user.email ?? user.id;
    const name = [user.firstName, user.lastName].filter(Boolean).join(" ") || fallback;

    return (
      <main className="min-h-screen bg-background px-6 py-5 text-foreground">
        <div className="mx-auto grid w-full max-w-2xl gap-6">
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="w-fit"
            onClick={() => setScreen("home")}
          >
            <ArrowLeft />
            Back
          </Button>
          <SettingsSection>
            <SettingsSectionTitle>Account</SettingsSectionTitle>
            <SettingsSectionBody>
              <SettingsRow className="px-4">
                <SettingsRowMain>
                  <Avatar className="size-10">
                    <AvatarFallback>{getInitials(name, fallback)}</AvatarFallback>
                  </Avatar>
                  <SettingsRowText
                    title={name}
                    description={name === fallback ? undefined : fallback}
                  />
                </SettingsRowMain>
              </SettingsRow>
              <SettingsRow className="px-4">
                <SettingsRowMain>
                  <SettingsRowIcon>
                    <CreditCard className="size-4" />
                  </SettingsRowIcon>
                  <SettingsRowText title="Billing" description="Manage subscription and invoices" />
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
                      <CloudOff className="size-4" />
                    ) : (
                      <StorageProviderIcon provider={storage.provider} />
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
                            setStorageError(messageFrom(cause, "Could not connect storage.")),
                          );
                        }}
                      >
                        <StorageProviderIcon provider={storageProvider} />
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
                        setStorageError(messageFrom(cause, "Could not connect storage.")),
                      );
                    }}
                  >
                    {storage.kind === "reauthorize" ? "Reconnect" : "Connect"}
                    <ArrowUpRight />
                  </Button>
                )}
              </SettingsRow>
              {storageError && <p className="px-4 pb-3 text-xs text-destructive">{storageError}</p>}
            </SettingsSectionBody>
          </SettingsSection>
          <SettingsSection>
            <SettingsSectionTitle>Appearance</SettingsSectionTitle>
            <SettingsSectionBody>
              <SettingsRow>
                <SettingsRowMain>
                  <SunMoon className="size-4 text-muted-foreground" />
                  <SettingsRowText
                    title="Theme"
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
                    <MessageCircle className="size-4 text-muted-foreground" />
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
      </main>
    );
  }

  const syncStatus: SyncStatus = runtime.loading
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
        if (files.length > 0) runAction(addFiles(files), "Could not add pasted files.");
        else {
          const text = event.clipboardData.getData("text/plain").trim();
          if (text) runAction(addText(text), "Could not add pasted text.");
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
        if (files.length > 0) runAction(addFiles(files), "Could not add dropped files.");
        else {
          const text = event.dataTransfer.getData("text/plain").trim();
          if (text) runAction(addText(text), "Could not add dropped text.");
        }
      }}
    >
      <div className="mx-auto flex w-full max-w-3xl flex-1 flex-col">
        <AppHeader
          className="mt-3"
          user={user}
          onSettingsClick={() => setScreen("settings")}
          onSignOutClick={() => runAction(runtime.signOut(), "Could not sign out.")}
          statusIndicator={<SyncStatusIndicator status={syncStatus} />}
          storageAction={
            storage.kind === "connected" ? (
              <Button
                type="button"
                variant="ghost"
                size="sm"
                onClick={() => openExternal(storage.destinationUrl)}
              >
                <StorageProviderIcon provider={storage.provider} />
                {storageProviderLabel(storage.provider)}
              </Button>
            ) : null
          }
        />
        <div className="flex min-h-0 flex-1 flex-col px-6 pb-6">
          <div className="sticky top-0 z-20 bg-background pt-5 pb-4">
            {blocked && !runtime.loading && (
              <div className="mb-2 flex items-center gap-2 rounded-md bg-muted px-2.5 py-1.5 text-xs text-muted-foreground">
                <TriangleAlert className="size-3.5 text-amber-600" />
                <span className="min-w-0 flex-1">
                  {capability.status === "OFFLINE"
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
                      ? openExternal("https://app.plakk.io/billing")
                      : setScreen("settings")
                  }
                >
                  {billingBlocked ? "Manage billing" : "Finish setup"}
                </Button>
              </div>
            )}
            <SnippetComposer.Root
              disabled={blocked}
              onSubmit={(text) => runAction(addText(text), "Could not add this snippet.")}
            >
              <SnippetComposer.Input />
              <SnippetComposer.Attachment>
                <input
                  multiple
                  onChange={(event) => {
                    if (event.currentTarget.files?.length) {
                      runAction(
                        addFiles(Array.from(event.currentTarget.files)),
                        "Could not add these files.",
                      );
                    }
                    event.currentTarget.value = "";
                  }}
                />
              </SnippetComposer.Attachment>
              <SnippetComposer.Submit />
            </SnippetComposer.Root>
            {(actionError ?? snippets.error) && (
              <p className="mt-2 text-xs text-destructive" role="alert">
                {actionError ?? snippets.error}
              </p>
            )}
          </div>
          {snippets.isLoading && snippets.items.length === 0 ? (
            <div className="grid flex-1 place-items-center text-muted-foreground">
              <LoaderCircle className="size-5 animate-spin" />
            </div>
          ) : snippets.error && snippets.items.length === 0 ? (
            <Button
              type="button"
              variant="ghost"
              onClick={() => runAction(snippets.reload(), "Could not refresh.")}
            >
              Try again
            </Button>
          ) : (
            <SnippetList.Root>
              <SnippetList.Heading />
              {snippets.items.length === 0 ? (
                <SnippetList.Empty />
              ) : (
                <SnippetList.Items>
                  {snippets.items.map((snippet) => (
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
                        runAction(deleteSnippet(snippet), "Could not remove this snippet.")
                      }
                      onDownload={() =>
                        runAction(downloadSnippet(snippet), "Could not download this snippet.")
                      }
                      onOpenLink={openExternal}
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

export const Route = createFileRoute("/")({ component: IndexRoute });
