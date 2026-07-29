import type { SnippetPresentation, StorageProvider, User } from "@plakk/shared";
import {
  accountCanSyncWithConnection,
  type AccountStatus,
  type StorageProviderStatus,
} from "@plakk/shared/PlakkApi";
import * as DateTime from "effect/DateTime";
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

import { getInitials } from "../lib/getInitials.ts";
import { AppHeader } from "./AppHeader.tsx";
import { SnippetComposer } from "./SnippetComposer.tsx";
import { SnippetList } from "./SnippetList.tsx";
import { SnippetRow, type SnippetRowItem } from "./SnippetRow.tsx";
import { SyncStatusIndicator, type ProductSyncStatus } from "./SyncStatusIndicator.tsx";
import { Avatar, AvatarFallback } from "./primitives/avatar.tsx";
import { Button } from "./primitives/button.tsx";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "./primitives/select.tsx";
import {
  SettingsRow,
  SettingsRowIcon,
  SettingsRowMain,
  SettingsRowText,
  SettingsSection,
  SettingsSectionBody,
  SettingsSectionTitle,
} from "./settings.tsx";
import { DropboxIcon } from "../icons/DropboxIcon.tsx";
import { GoogleDriveIcon } from "../icons/GoogleDriveIcon.tsx";
import { OneDriveIcon } from "../icons/OneDriveIcon.tsx";

export type ProductSnippet = SnippetRowItem & {
  readonly presentation: SnippetPresentation;
};

export type ProductCapability =
  | {
      readonly status: "OFFLINE";
      readonly storageProvider: {
        readonly known: boolean;
        readonly value: StorageProvider | null;
      };
    }
  | {
      readonly status: "ONLINE";
      readonly account: AccountStatus;
      readonly connection: StorageProviderStatus | null;
    };

export type ProductAppProps = {
  readonly appearance: "light" | "dark" | "system";
  readonly capability: ProductCapability;
  readonly error: string | null;
  readonly loading: boolean;
  readonly snippets: ReadonlyArray<ProductSnippet>;
  readonly syncStatus: "CONNECTED" | "RECONNECTING" | null;
  readonly user: User | null;
  readonly onAppearanceChange: (appearance: "light" | "dark" | "system") => Promise<void>;
  readonly onCopy: (snippet: ProductSnippet) => Promise<void>;
  readonly onDelete: (snippet: ProductSnippet) => Promise<void>;
  readonly onDownload: (snippet: ProductSnippet) => Promise<void>;
  readonly onFiles: (files: ReadonlyArray<File>) => Promise<void>;
  readonly onOpenExternal: (url: string) => void;
  readonly onRefresh: () => Promise<void>;
  readonly onSignIn: () => void;
  readonly onSignOut: () => Promise<void>;
  readonly onText: (text: string) => Promise<void>;
};

const providerLabel = (provider: StorageProvider) => {
  switch (provider) {
    case "GOOGLE_DRIVE":
      return "Google Drive";
    case "ONE_DRIVE":
      return "OneDrive";
    case "DROPBOX":
      return "Dropbox";
  }
};

const ProviderIcon = ({ provider }: { readonly provider: StorageProvider }) => {
  switch (provider) {
    case "GOOGLE_DRIVE":
      return <GoogleDriveIcon className="size-5" />;
    case "ONE_DRIVE":
      return <OneDriveIcon className="size-5" />;
    case "DROPBOX":
      return <DropboxIcon className="size-5" />;
  }
};

type StorageState =
  | { readonly kind: "offline"; readonly provider: StorageProvider | null }
  | { readonly kind: "unlinked" }
  | { readonly kind: "unavailable"; readonly provider: StorageProvider }
  | { readonly kind: "reauthorize"; readonly provider: StorageProvider }
  | {
      readonly kind: "connected";
      readonly provider: StorageProvider;
      readonly destinationUrl: string;
      readonly canSync: boolean;
      readonly account: AccountStatus;
    };

const storageState = (capability: ProductCapability): StorageState => {
  if (capability.status === "OFFLINE") {
    return {
      kind: "offline" as const,
      provider: capability.storageProvider.value,
    };
  }
  const provider = capability.account.storageProvider;
  if (provider === null) return { kind: "unlinked" as const };
  const connection = capability.connection;
  if (connection?.storageProvider !== provider) return { kind: "unavailable" as const, provider };
  if (connection.status === "NEEDS_REAUTHORIZATION") {
    return { kind: "reauthorize" as const, provider };
  }
  if (connection.status === "NOT_CONNECTED") return { kind: "unlinked" as const };
  if (connection.externalDestinationUrl === null) {
    return { kind: "unavailable", provider };
  }
  return {
    kind: "connected" as const,
    provider,
    destinationUrl: connection.externalDestinationUrl,
    canSync: accountCanSyncWithConnection(capability.account, connection),
    account: capability.account,
  };
};

const messageFrom = (cause: unknown, fallback: string) =>
  cause instanceof Error && cause.message.trim() ? cause.message : fallback;

function Welcome(props: Pick<ProductAppProps, "error" | "loading" | "onSignIn">) {
  return (
    <main className="grid min-h-screen place-items-center bg-background p-6 text-foreground">
      <section className="grid w-full max-w-md gap-5 text-center">
        <div className="grid gap-1">
          <p className="text-xs font-medium tracking-wide text-muted-foreground uppercase">Plakk</p>
          <h1 className="text-2xl leading-tight font-semibold">Move snippets between devices.</h1>
        </div>
        {props.error && <p className="text-xs text-destructive">{props.error}</p>}
        <Button
          type="button"
          className="h-10 w-full"
          disabled={props.loading}
          onClick={props.onSignIn}
        >
          {props.loading ? "Checking session…" : "Sign in"}
          <ArrowUpRight />
        </Button>
      </section>
    </main>
  );
}

function SettingsView(props: ProductAppProps & { readonly onBack: () => void }) {
  const { capability, user } = props;
  const storage = storageState(capability);
  const [appearanceError, setAppearanceError] = useState<string | null>(null);
  if (user === null) return null;
  const fallback = user.email ?? user.id;
  const name = [user.firstName, user.lastName].filter(Boolean).join(" ") || fallback;

  return (
    <main className="min-h-screen bg-background px-6 py-5 text-foreground">
      <div className="mx-auto grid w-full max-w-2xl gap-6">
        <Button type="button" variant="ghost" size="sm" className="w-fit" onClick={props.onBack}>
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
              <span className="rounded-full bg-muted px-2 py-1 text-[11px] text-muted-foreground">
                Pro
              </span>
            </SettingsRow>
            <SettingsRow className="px-4">
              <SettingsRowMain>
                <SettingsRowIcon>
                  <CreditCard className="size-4" />
                </SettingsRowIcon>
                <SettingsRowText title="Plakk Pro" description="Current plan" />
              </SettingsRowMain>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                onClick={() => props.onOpenExternal("https://app.plakk.io/billing")}
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
                    <ProviderIcon provider={storage.provider} />
                  )}
                </SettingsRowIcon>
                <SettingsRowText
                  title={
                    storage.kind === "connected"
                      ? `${providerLabel(storage.provider)} connected`
                      : storage.kind === "reauthorize"
                        ? `${providerLabel(storage.provider)} needs reconnection`
                        : storage.kind === "offline" && storage.provider !== null
                          ? `${providerLabel(storage.provider)} linked`
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
                  onClick={() => props.onOpenExternal(storage.destinationUrl)}
                >
                  Open
                  <ArrowUpRight />
                </Button>
              ) : (
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  onClick={() => props.onOpenExternal("https://app.plakk.io/storage")}
                >
                  {storage.kind === "reauthorize" ? "Reconnect" : "Connect"}
                  <ArrowUpRight />
                </Button>
              )}
            </SettingsRow>
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
                value={props.appearance}
                onValueChange={(value) => {
                  if (value === null) return;
                  setAppearanceError(null);
                  void props
                    .onAppearanceChange(value as ProductAppProps["appearance"])
                    .catch(() => setAppearanceError("Could not save the appearance setting."));
                }}
              >
                <SelectTrigger aria-label="Appearance">
                  <SelectValue>
                    {props.appearance === "system"
                      ? "System"
                      : props.appearance === "dark"
                        ? "Dark"
                        : "Light"}
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
            {appearanceError && (
              <p className="px-4 py-2 text-xs text-destructive">{appearanceError}</p>
            )}
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
                  onClick={() => props.onOpenExternal(url!)}
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

function HomeView(props: ProductAppProps & { readonly onSettings: () => void }) {
  const storage = storageState(props.capability);
  const blocked = storage.kind !== "connected" || !storage.canSync;
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
  const copy = (snippet: ProductSnippet) => {
    setCopyingId(snippet.id);
    void props
      .onCopy(snippet)
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
  const syncStatus: ProductSyncStatus = props.loading
    ? "CHECKING"
    : props.capability.status === "OFFLINE"
      ? "OFFLINE"
      : blocked
        ? "PAUSED"
        : props.syncStatus === "CONNECTED"
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
        if (files.length > 0) run(props.onFiles(files), "Could not add pasted files.");
        else {
          const text = event.clipboardData.getData("text/plain").trim();
          if (text) run(props.onText(text), "Could not add pasted text.");
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
        if (files.length > 0) run(props.onFiles(files), "Could not add dropped files.");
        else {
          const text = event.dataTransfer.getData("text/plain").trim();
          if (text) run(props.onText(text), "Could not add dropped text.");
        }
      }}
    >
      <div className="mx-auto flex w-full max-w-3xl flex-1 flex-col">
        <AppHeader
          className="mt-3"
          user={props.user!}
          onSettingsClick={props.onSettings}
          onSignOutClick={() => run(props.onSignOut(), "Could not sign out.")}
          statusIndicator={<SyncStatusIndicator status={syncStatus} />}
          storageAction={
            storage.kind === "connected" ? (
              <Button
                type="button"
                variant="ghost"
                size="sm"
                onClick={() => props.onOpenExternal(storage.destinationUrl)}
              >
                <ProviderIcon provider={storage.provider} />
                {providerLabel(storage.provider)}
              </Button>
            ) : null
          }
        />
        <div className="flex min-h-0 flex-1 flex-col px-6 pb-6">
          <div className="sticky top-0 z-20 bg-background pt-5 pb-4">
            {blocked && !props.loading && (
              <div className="mb-2 flex items-center gap-2 rounded-md bg-muted px-2.5 py-1.5 text-xs text-muted-foreground">
                <TriangleAlert className="size-3.5 text-amber-600" />
                <span className="min-w-0 flex-1">
                  {props.capability.status === "OFFLINE"
                    ? "Offline — your saved snippet list remains available."
                    : "Sync is paused until account storage is ready."}
                </span>
                <Button
                  type="button"
                  variant="ghost"
                  size="xs"
                  onClick={() => props.onOpenExternal("https://app.plakk.io/storage")}
                >
                  Finish setup
                </Button>
              </div>
            )}
            <SnippetComposer
              disabled={blocked}
              onSubmit={(text) => run(props.onText(text), "Could not add this snippet.")}
              onFiles={(files) =>
                run(props.onFiles(Array.from(files)), "Could not add these files.")
              }
            />
            {(actionError ?? props.error) && (
              <p className="mt-2 text-xs text-destructive" role="alert">
                {actionError ?? props.error}
              </p>
            )}
          </div>
          {props.loading && props.snippets.length === 0 ? (
            <div className="grid flex-1 place-items-center text-muted-foreground">
              <LoaderCircle className="size-5 animate-spin" />
            </div>
          ) : props.error && props.snippets.length === 0 ? (
            <Button
              type="button"
              variant="ghost"
              onClick={() => run(props.onRefresh(), "Could not refresh.")}
            >
              Try again
            </Button>
          ) : (
            <SnippetList empty={props.snippets.length === 0}>
              {props.snippets.map((snippet) => (
                <SnippetRow
                  key={snippet.id}
                  snippet={snippet}
                  presentation={snippet.presentation}
                  now={now}
                  copied={copiedId === snippet.id}
                  copying={copyingId === snippet.id}
                  copyDisabled={snippet.kind !== "PUBLISHED"}
                  onCopy={() => copy(snippet)}
                  onDelete={() => run(props.onDelete(snippet), "Could not remove this snippet.")}
                  onDownload={() =>
                    run(props.onDownload(snippet), "Could not download this snippet.")
                  }
                  onOpenLink={(url) => props.onOpenExternal(url)}
                  contentMode="remote"
                />
              ))}
            </SnippetList>
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

export function ProductApp(props: ProductAppProps) {
  const [view, setView] = useState<"home" | "settings">("home");
  if (props.user === null) {
    return <Welcome error={props.error} loading={props.loading} onSignIn={props.onSignIn} />;
  }
  return view === "settings" ? (
    <SettingsView {...props} onBack={() => setView("home")} />
  ) : (
    <HomeView {...props} onSettings={() => setView("settings")} />
  );
}
