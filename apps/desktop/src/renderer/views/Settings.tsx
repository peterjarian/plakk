import { useEffect, useRef, useState } from "react";
import { formatFileSize } from "@plakk/shared";
import {
  ArrowLeft,
  ArrowUpRight,
  CloudOff,
  CreditCard,
  FileText,
  HardDrive,
  MessageCircle,
  RefreshCw,
  SunMoon,
  SquareMenu,
} from "lucide-react";
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
import { Switch } from "@plakk/ui/primitives/switch";
import { ProductNotice } from "@plakk/ui/components/ProductNotice";
import {
  StorageProviderIcon,
  storageProviderLabel,
} from "@plakk/ui/components/StorageProviderIcon";
import { Settings as SettingsUI } from "@plakk/ui/components/settings";
import { getInitials } from "@plakk/ui/lib/getInitials";
import { useAuth } from "../hooks/useAuth.ts";
import { setAppearancePreference, useAppearance } from "../hooks/useAppearance.ts";
import { useLocalState } from "../hooks/useLocalState.tsx";
import {
  openStorageSetup,
  useLinkedStorageProvider,
  useStorageStatus,
} from "../hooks/useStorageStatus.tsx";
import { ipcActionErrorMessage } from "../lib/ipcActionErrorMessage.ts";
import { navigate } from "../lib/navigate.ts";

type StorageFeedback =
  | {
      readonly kind: "reclaimed";
      readonly reclaimedBytes: number;
      readonly removedCopies: number;
    }
  | { readonly kind: "no-op" }
  | { readonly kind: "failed"; readonly message: string };

const appearanceLabels = {
  light: "Light",
  dark: "Dark",
  system: "System",
} as const;

export function Settings() {
  const auth = useAuth();
  const linkedProvider = useLinkedStorageProvider();
  const storageStatus = useStorageStatus();
  const { localState } = useLocalState();
  const appearance = useAppearance();
  const [autoUpdate, setAutoUpdate] = useState(true);
  const [toolbarWidget, setToolbarWidget] = useState<boolean | null>(null);
  const [toolbarWidgetSaving, setToolbarWidgetSaving] = useState(false);
  const [toolbarWidgetError, setToolbarWidgetError] = useState<string | null>(null);
  const [updateStatus, setUpdateStatus] = useState("Up to date");
  const [freeingStorage, setFreeingStorage] = useState(false);
  const [storageFeedback, setStorageFeedback] = useState<StorageFeedback | null>(null);
  const [storageResult, setStorageResult] = useState<{
    readonly localStateRevision: number;
    readonly storageUsageBytes: number;
  } | null>(null);
  const freeingStorageRef = useRef(false);
  const localStateRevisionRef = useRef(localState.revision);
  localStateRevisionRef.current = localState.revision;
  const storageUsageBytes =
    storageResult !== null && localState.revision <= storageResult.localStateRevision
      ? storageResult.storageUsageBytes
      : localState.storageUsageBytes;
  const [appearanceError, setAppearanceError] = useState<string | null>(null);
  const [savingAppearance, setSavingAppearance] = useState(false);
  const user = auth.user;

  useEffect(() => {
    let active = true;
    void window.ipc.userConfig.get().then(
      (config) => {
        if (active) setToolbarWidget(config.toolbarWidgetEnabled);
      },
      () => {
        if (active) setToolbarWidgetError("Could not load this preference.");
      },
    );
    return () => {
      active = false;
    };
  }, []);

  function updateToolbarWidget(enabled: boolean) {
    if (toolbarWidget === null || toolbarWidgetSaving) return;
    const previous = toolbarWidget;
    setToolbarWidget(enabled);
    setToolbarWidgetSaving(true);
    setToolbarWidgetError(null);
    void window.ipc.userConfig.set({ toolbarWidgetEnabled: enabled }).then(
      (config) => {
        setToolbarWidget(config.toolbarWidgetEnabled);
        setToolbarWidgetSaving(false);
      },
      () => {
        setToolbarWidget(previous);
        setToolbarWidgetSaving(false);
        setToolbarWidgetError("Could not save this preference.");
      },
    );
  }

  if (user === null) return null;

  const fallback = user.email || user.id;
  const name = [user.firstName, user.lastName].filter(Boolean).join(" ") || fallback;

  return (
    <main className="flex h-screen flex-col overflow-hidden bg-background text-foreground">
      <div className="drag-region h-12 shrink-0" aria-hidden="true" />

      <div className="scrollbar-hidden min-h-0 flex-1 overflow-y-auto px-6 pb-4">
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="-ml-2 mb-4"
          onClick={() => navigate("home")}
        >
          <ArrowLeft />
          Back
        </Button>
        <div className="grid gap-6">
          <SettingsUI.Section>
            <SettingsUI.SectionTitle>Account</SettingsUI.SectionTitle>
            <SettingsUI.SectionBody>
              <SettingsUI.Row className="px-4">
                <SettingsUI.RowMain>
                  <Avatar className="size-10">
                    <AvatarFallback className="text-sm font-medium">
                      {getInitials(name, fallback)}
                    </AvatarFallback>
                  </Avatar>
                  <SettingsUI.RowText
                    title={name}
                    description={name === fallback ? undefined : fallback}
                  />
                </SettingsUI.RowMain>
                <span className="rounded-full bg-muted px-2 py-1 text-[11px] leading-none font-medium text-muted-foreground">
                  Pro
                </span>
              </SettingsUI.Row>

              <SettingsUI.Row className="px-4">
                <SettingsUI.RowMain>
                  <SettingsUI.RowIcon>
                    <CreditCard className="size-4 text-muted-foreground" aria-hidden="true" />
                  </SettingsUI.RowIcon>
                  <SettingsUI.RowText title="Plakk Pro" description="Current plan" />
                </SettingsUI.RowMain>
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  onClick={() => void window.ipc.openExternal("https://app.plakk.io/billing")}
                >
                  Manage
                  <ArrowUpRight />
                </Button>
              </SettingsUI.Row>

              {storageStatus.kind === "loading" ||
              storageStatus.kind === "failed" ||
              storageStatus.kind === "offline" ? (
                <SettingsUI.Row className="px-4">
                  <SettingsUI.RowMain>
                    <SettingsUI.RowIcon>
                      <CloudOff className="size-4 text-muted-foreground" aria-hidden="true" />
                    </SettingsUI.RowIcon>
                    <SettingsUI.RowText
                      title={
                        storageStatus.kind === "loading"
                          ? "Checking storage"
                          : storageStatus.kind === "offline" && linkedProvider !== null
                            ? `${storageProviderLabel(linkedProvider)} linked`
                            : "Storage status unavailable"
                      }
                      description={
                        storageStatus.kind === "loading"
                          ? "Checking your storage connection."
                          : storageStatus.kind === "offline"
                            ? "Offline — showing the last confirmed storage provider."
                            : "Could not check storage. Try again shortly."
                      }
                    />
                  </SettingsUI.RowMain>
                </SettingsUI.Row>
              ) : storageStatus.kind === "unlinked" ? (
                <SettingsUI.Row className="px-4">
                  <SettingsUI.RowMain>
                    <SettingsUI.RowIcon>
                      <CloudOff className="size-4 text-amber-600" aria-hidden="true" />
                    </SettingsUI.RowIcon>
                    <SettingsUI.RowText
                      title="Storage not linked"
                      description="Connect storage to sync snippets."
                    />
                  </SettingsUI.RowMain>
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    onClick={() => openStorageSetup(storageStatus.actionUrl)}
                  >
                    Connect
                    <ArrowUpRight />
                  </Button>
                </SettingsUI.Row>
              ) : storageStatus.kind === "needs-reauthorization" ? (
                <SettingsUI.Row className="px-4">
                  <SettingsUI.RowMain>
                    <SettingsUI.RowIcon>
                      <StorageProviderIcon provider={storageStatus.provider} className="size-5" />
                    </SettingsUI.RowIcon>
                    <SettingsUI.RowText
                      title={`${storageProviderLabel(storageStatus.provider)} needs reconnection`}
                      description="Reconnect storage to resume syncing snippets."
                    />
                  </SettingsUI.RowMain>
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    onClick={() => openStorageSetup(storageStatus.actionUrl)}
                  >
                    Reconnect
                    <ArrowUpRight />
                  </Button>
                </SettingsUI.Row>
              ) : (
                <SettingsUI.Row className="px-4">
                  <SettingsUI.RowMain>
                    <SettingsUI.RowIcon>
                      <StorageProviderIcon provider={storageStatus.provider} className="size-5" />
                    </SettingsUI.RowIcon>
                    <SettingsUI.RowText
                      title={`${storageProviderLabel(storageStatus.provider)} connected`}
                      description={
                        storageStatus.canSync
                          ? "Syncing snippets to this storage provider."
                          : storageStatus.account.blockedReasons.includes("billing")
                            ? "Sync paused until billing is resolved."
                            : "Sync is currently paused."
                      }
                    />
                  </SettingsUI.RowMain>
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    onClick={() => void window.ipc.openExternal(storageStatus.destinationUrl)}
                  >
                    Open
                    <ArrowUpRight />
                  </Button>
                </SettingsUI.Row>
              )}
            </SettingsUI.SectionBody>
          </SettingsUI.Section>

          <SettingsUI.Section>
            <SettingsUI.SectionTitle>Device storage</SettingsUI.SectionTitle>
            <SettingsUI.SectionBody>
              <SettingsUI.Row className="items-start">
                <SettingsUI.RowMain className="flex-1 items-start">
                  <HardDrive
                    className="mt-0.5 size-4 shrink-0 text-muted-foreground"
                    aria-hidden="true"
                  />
                  <SettingsUI.RowText
                    title={`${formatFileSize(storageUsageBytes)} used by Plakk`}
                    description="Freeing space keeps your newest 20 eligible snippets available and removes older device copies only."
                    descriptionClassName="overflow-visible text-clip whitespace-normal"
                  />
                </SettingsUI.RowMain>
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  disabled={freeingStorage}
                  onClick={() => {
                    if (freeingStorageRef.current) return;
                    freeingStorageRef.current = true;
                    setStorageFeedback(null);
                    setFreeingStorage(true);
                    void window.ipc.storage.freeUp().then(
                      (result) => {
                        freeingStorageRef.current = false;
                        setFreeingStorage(false);
                        setStorageResult({
                          localStateRevision: localStateRevisionRef.current,
                          storageUsageBytes: result.storageUsageBytes,
                        });
                        setStorageFeedback(
                          result.removedCopies === 0
                            ? { kind: "no-op" }
                            : {
                                kind: "reclaimed",
                                reclaimedBytes: result.reclaimedBytes,
                                removedCopies: result.removedCopies,
                              },
                        );
                      },
                      (cause: unknown) => {
                        freeingStorageRef.current = false;
                        setFreeingStorage(false);
                        setStorageFeedback({
                          kind: "failed",
                          message: ipcActionErrorMessage(
                            cause,
                            "Plakk couldn’t free device space. Try again.",
                          ),
                        });
                      },
                    );
                  }}
                >
                  {freeingStorage ? "Freeing…" : "Free up space"}
                </Button>
              </SettingsUI.Row>
              {storageFeedback?.kind === "failed" ? (
                <ProductNotice className="mx-4 my-2" tone="danger" title={storageFeedback.message}>
                  No device copies were removed. Try again.
                </ProductNotice>
              ) : storageFeedback !== null ? (
                <p
                  className="px-4 py-2 text-xs text-muted-foreground"
                  role="status"
                  aria-live="polite"
                >
                  {storageFeedback.kind === "reclaimed"
                    ? storageFeedback.reclaimedBytes > 0
                      ? `Reclaimed ${formatFileSize(storageFeedback.reclaimedBytes)} on this device.`
                      : `Removed ${storageFeedback.removedCopies} older device ${
                          storageFeedback.removedCopies === 1 ? "copy" : "copies"
                        } from this device.`
                    : "No older device copies are available to remove."}
                </p>
              ) : null}
            </SettingsUI.SectionBody>
          </SettingsUI.Section>

          <SettingsUI.Section>
            <SettingsUI.SectionTitle>Desktop</SettingsUI.SectionTitle>
            <SettingsUI.SectionBody>
              <SettingsUI.Row>
                <SettingsUI.RowMain>
                  <SunMoon className="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
                  <SettingsUI.RowText
                    title="Appearance"
                    description="Choose a theme or follow your system."
                  />
                </SettingsUI.RowMain>
                <Select
                  disabled={savingAppearance}
                  value={appearance.preference}
                  onValueChange={(value) => {
                    if (value === null) return;
                    setAppearanceError(null);
                    setSavingAppearance(true);
                    void setAppearancePreference(value as "light" | "dark" | "system").then(
                      () => setSavingAppearance(false),
                      () => {
                        setSavingAppearance(false);
                        setAppearanceError("Could not save the appearance setting.");
                      },
                    );
                  }}
                >
                  <SelectTrigger aria-label="Appearance">
                    <SelectValue>{appearanceLabels[appearance.preference]}</SelectValue>
                  </SelectTrigger>
                  <SelectContent align="end">
                    <SelectGroup>
                      <SelectItem value="light">{appearanceLabels.light}</SelectItem>
                      <SelectItem value="dark">{appearanceLabels.dark}</SelectItem>
                      <SelectItem value="system">{appearanceLabels.system}</SelectItem>
                    </SelectGroup>
                  </SelectContent>
                </Select>
              </SettingsUI.Row>
              {appearanceError !== null && (
                <ProductNotice className="mx-4 my-2" tone="danger" title={appearanceError}>
                  Your previous appearance setting is still active.
                </ProductNotice>
              )}

              <SettingsUI.Row>
                <SettingsUI.RowMain>
                  <SquareMenu
                    className="size-4 shrink-0 text-muted-foreground"
                    aria-hidden="true"
                  />
                  <SettingsUI.RowText
                    title="Toolbar widget"
                    description="Show quick access from the desktop toolbar."
                  />
                </SettingsUI.RowMain>
                <Switch
                  aria-label="Toolbar widget"
                  checked={toolbarWidget ?? false}
                  disabled={toolbarWidget === null || toolbarWidgetSaving}
                  onCheckedChange={updateToolbarWidget}
                />
              </SettingsUI.Row>
              {toolbarWidgetError !== null && (
                <ProductNotice className="mx-4 my-2" tone="danger" title={toolbarWidgetError}>
                  Your previous toolbar setting is still active.
                </ProductNotice>
              )}
            </SettingsUI.SectionBody>
          </SettingsUI.Section>

          <SettingsUI.Section>
            <SettingsUI.SectionTitle>App</SettingsUI.SectionTitle>
            <SettingsUI.SectionBody>
              <SettingsUI.Row>
                <SettingsUI.RowMain>
                  <RefreshCw className="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
                  <SettingsUI.RowText title="Plakk Desktop 0.1.0" description={updateStatus} />
                </SettingsUI.RowMain>
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={() => setUpdateStatus("Checked just now")}
                >
                  Check
                </Button>
              </SettingsUI.Row>

              <SettingsUI.Row>
                <SettingsUI.RowText
                  title="Auto update"
                  description="Install updates in the background."
                />
                <Switch checked={autoUpdate} onCheckedChange={setAutoUpdate} />
              </SettingsUI.Row>

              <SettingsUI.Row>
                <SettingsUI.RowMain>
                  <FileText className="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
                  <SettingsUI.RowText title="Logs" description="Open diagnostic files." />
                </SettingsUI.RowMain>
                <Button type="button" variant="outline" size="sm">
                  Open
                </Button>
              </SettingsUI.Row>
            </SettingsUI.SectionBody>
          </SettingsUI.Section>

          <SettingsUI.Section>
            <SettingsUI.SectionTitle>Help</SettingsUI.SectionTitle>
            <SettingsUI.SectionBody>
              <SettingsUI.Row>
                <SettingsUI.RowMain>
                  <MessageCircle
                    className="size-4 shrink-0 text-muted-foreground"
                    aria-hidden="true"
                  />
                  <SettingsUI.RowText
                    title="Contact us"
                    description="Get help from the Plakk team."
                  />
                </SettingsUI.RowMain>
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={() => void window.ipc.openExternal("https://app.plakk.io/contact")}
                >
                  Open
                </Button>
              </SettingsUI.Row>
              <SettingsUI.Row>
                <SettingsUI.RowMain>
                  <MessageCircle
                    className="size-4 shrink-0 text-muted-foreground"
                    aria-hidden="true"
                  />
                  <SettingsUI.RowText
                    title="Give feedback"
                    description="Share what is working or missing."
                  />
                </SettingsUI.RowMain>
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={() => void window.ipc.openExternal("https://app.plakk.io/feedback")}
                >
                  Open
                </Button>
              </SettingsUI.Row>
            </SettingsUI.SectionBody>
          </SettingsUI.Section>
        </div>
      </div>
    </main>
  );
}
