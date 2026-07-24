import { useEffect, useRef, useState } from "react";
import {
  formatForDisplay,
  normalizeHotkeyFromEvent,
  useHotkeyRecorder,
} from "@tanstack/react-hotkeys";
import { formatFileSize } from "@plakk/shared";
import {
  ArrowLeft,
  ArrowUpRight,
  CloudOff,
  CreditCard,
  FileText,
  HardDrive,
  Keyboard,
  MessageCircle,
  RefreshCw,
  SunMoon,
  SquareMenu,
} from "lucide-react";
import { Avatar, AvatarFallback } from "@plakk/ui/components/primitives/avatar";
import { Button } from "@plakk/ui/components/primitives/button";
import { Switch } from "@plakk/ui/components/primitives/switch";
import {
  SettingsRow,
  SettingsRowAction,
  SettingsRowIcon,
  SettingsRowMain,
  SettingsRowText,
  SettingsSection,
  SettingsSectionBody,
  SettingsSectionTitle,
} from "@plakk/ui/components/settings";
import { getInitials } from "@plakk/ui/lib/getInitials";
import type { GlobalHotkeyStatus, GlobalHotkeyUpdate } from "../../ipc/contracts.ts";
import { useAuth } from "../hooks/useAuth.ts";
import { setAppearancePreference, useAppearance } from "../hooks/useAppearance.ts";
import { useLocalState } from "../hooks/useLocalState.tsx";
import {
  StorageProviderIcon,
  storageProviderLabel,
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

const shiftedKeyBase: Readonly<Record<string, string>> = {
  "!": "1",
  '"': "'",
  "#": "3",
  $: "4",
  "%": "5",
  "&": "7",
  "(": "9",
  ")": "0",
  "*": "8",
  "+": "=",
  ":": ";",
  "<": ",",
  ">": ".",
  "?": "/",
  "@": "2",
  "^": "6",
  _: "-",
  "{": "[",
  "|": "\\",
  "}": "]",
  "~": "`",
};

export function normalizeRecordedHotkey(shortcut: string) {
  const recordsPlusKey = shortcut.endsWith("++");
  const separator = recordsPlusKey ? shortcut.length - 2 : shortcut.lastIndexOf("+");
  if (separator < 0) return shortcut;

  const modifiers = shortcut.slice(0, separator).split("+");
  const key = recordsPlusKey ? "+" : shortcut.slice(separator + 1);
  const baseKey = modifiers.includes("Shift") ? shiftedKeyBase[key] : undefined;
  return baseKey === undefined ? shortcut : `${modifiers.join("+")}+${baseKey}`;
}

export function GlobalHotkeyControl({
  busy,
  error,
  isRecording,
  onBeginRecording,
  onCancelRecording,
  onUpdate,
  status,
}: {
  readonly busy: boolean;
  readonly error: string | null;
  readonly isRecording: boolean;
  readonly onBeginRecording: () => void;
  readonly onCancelRecording: () => void;
  readonly onUpdate: (patch: GlobalHotkeyUpdate) => void;
  readonly status: GlobalHotkeyStatus | null;
}) {
  return (
    <>
      <SettingsRow>
        <SettingsRowMain>
          <Keyboard className="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
          <SettingsRowText title="Global hotkey" description="Open Plakk from anywhere." />
        </SettingsRowMain>
        <SettingsRowAction>
          <Button
            type="button"
            variant="outline"
            size="sm"
            aria-label={isRecording ? "Listening for a global hotkey" : "Record global hotkey"}
            disabled={busy || status === null || !status.enabled}
            onClick={onBeginRecording}
          >
            {isRecording
              ? "Press shortcut…"
              : status === null
                ? "Loading…"
                : formatForDisplay(status.shortcut)}
          </Button>
          {isRecording && (
            <Button type="button" variant="ghost" size="sm" onClick={onCancelRecording}>
              Cancel
            </Button>
          )}
          <Switch
            aria-label="Enable global hotkey"
            checked={status?.enabled ?? false}
            disabled={busy || status === null || isRecording}
            onCheckedChange={(enabled) => onUpdate({ enabled })}
          />
        </SettingsRowAction>
      </SettingsRow>
      {isRecording && (
        <p className="px-4 py-2 text-xs text-muted-foreground" role="status">
          Listening… Press a shortcut, or press Escape to cancel.
        </p>
      )}
      {error !== null && (
        <p className="px-4 py-2 text-xs text-destructive" role="alert">
          {error}
        </p>
      )}
    </>
  );
}

export function Settings({ active = true }: { readonly active?: boolean }) {
  const auth = useAuth();
  const linkedProvider = useLinkedStorageProvider();
  const storageStatus = useStorageStatus();
  const { localState } = useLocalState();
  const appearance = useAppearance();
  const [autoUpdate, setAutoUpdate] = useState(true);
  const [globalHotkeyStatus, setGlobalHotkeyStatus] = useState<GlobalHotkeyStatus | null>(null);
  const [globalHotkeyBusy, setGlobalHotkeyBusy] = useState(false);
  const [globalHotkeyError, setGlobalHotkeyError] = useState<string | null>(null);
  const [toolbarWidget, setToolbarWidget] = useState(true);
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

  const recorder = useHotkeyRecorder({
    ignoreInputs: false,
    onRecord: (shortcut) => {
      if (!shortcut) {
        void cancelGlobalHotkeyRecording();
        return;
      }
      void updateGlobalHotkey({ shortcut: normalizeRecordedHotkey(shortcut) });
    },
    onCancel: () => {
      void cancelGlobalHotkeyRecording();
    },
  });

  useEffect(() => {
    window.ipc.globalHotkey.get().then(
      (status) => {
        setGlobalHotkeyStatus(status);
        setGlobalHotkeyError(status.errorMessage);
      },
      (cause) =>
        setGlobalHotkeyError(ipcActionErrorMessage(cause, "Could not load the global hotkey.")),
    );
  }, []);

  useEffect(() => {
    if (!active && recorder.isRecording) recorder.cancelRecording();
  }, [active, recorder]);

  useEffect(() => {
    if (!recorder.isRecording) return;
    const cancelOnBlur = () => recorder.cancelRecording();
    const recordShiftedPlus = (event: KeyboardEvent) => {
      if (event.key !== "+" || !event.shiftKey) return;
      event.preventDefault();
      event.stopPropagation();
      recorder.stopRecording();
      void updateGlobalHotkey({
        shortcut: normalizeRecordedHotkey(normalizeHotkeyFromEvent(event)),
      });
    };
    window.addEventListener("blur", cancelOnBlur);
    window.addEventListener("keydown", recordShiftedPlus, true);
    return () => {
      window.removeEventListener("blur", cancelOnBlur);
      window.removeEventListener("keydown", recordShiftedPlus, true);
    };
  }, [recorder]);

  if (user === null) return null;

  async function beginGlobalHotkeyRecording() {
    setGlobalHotkeyBusy(true);
    setGlobalHotkeyError(null);
    try {
      await window.ipc.globalHotkey.beginRecording();
      recorder.startRecording();
    } catch (cause) {
      setGlobalHotkeyError(ipcActionErrorMessage(cause, "Could not start recording a shortcut."));
    } finally {
      setGlobalHotkeyBusy(false);
    }
  }

  async function cancelGlobalHotkeyRecording() {
    setGlobalHotkeyBusy(true);
    try {
      const status = await window.ipc.globalHotkey.cancelRecording();
      setGlobalHotkeyStatus(status);
      setGlobalHotkeyError(status.errorMessage);
    } catch (cause) {
      setGlobalHotkeyError(ipcActionErrorMessage(cause, "Could not restore the global hotkey."));
    } finally {
      setGlobalHotkeyBusy(false);
    }
  }

  async function updateGlobalHotkey(patch: GlobalHotkeyUpdate) {
    setGlobalHotkeyBusy(true);
    setGlobalHotkeyError(null);
    try {
      const status = await window.ipc.globalHotkey.update(patch);
      setGlobalHotkeyStatus(status);
      setGlobalHotkeyError(status.errorMessage);
    } catch (cause) {
      setGlobalHotkeyError(ipcActionErrorMessage(cause, "Could not update the global hotkey."));
      void window.ipc.globalHotkey.get().then(setGlobalHotkeyStatus, () => {});
    } finally {
      setGlobalHotkeyBusy(false);
    }
  }

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
                  onClick={() => void window.ipc.openExternal("https://app.plakk.io/billing")}
                >
                  Manage
                  <ArrowUpRight />
                </Button>
              </SettingsRow>

              {storageStatus.kind === "loading" ||
              storageStatus.kind === "failed" ||
              storageStatus.kind === "offline" ? (
                <SettingsRow className="px-4">
                  <SettingsRowMain>
                    <SettingsRowIcon>
                      <CloudOff className="size-4 text-muted-foreground" aria-hidden="true" />
                    </SettingsRowIcon>
                    <SettingsRowText
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
                  </SettingsRowMain>
                </SettingsRow>
              ) : storageStatus.kind === "unlinked" ? (
                <SettingsRow className="px-4">
                  <SettingsRowMain>
                    <SettingsRowIcon>
                      <CloudOff className="size-4 text-amber-600" aria-hidden="true" />
                    </SettingsRowIcon>
                    <SettingsRowText
                      title="Storage not linked"
                      description="Connect storage to sync snippets."
                    />
                  </SettingsRowMain>
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    onClick={() => openStorageSetup(storageStatus.actionUrl)}
                  >
                    Connect
                    <ArrowUpRight />
                  </Button>
                </SettingsRow>
              ) : storageStatus.kind === "needs-reauthorization" ? (
                <SettingsRow className="px-4">
                  <SettingsRowMain>
                    <SettingsRowIcon>
                      <StorageProviderIcon provider={storageStatus.provider} className="size-5" />
                    </SettingsRowIcon>
                    <SettingsRowText
                      title={`${storageProviderLabel(storageStatus.provider)} needs reconnection`}
                      description="Reconnect storage to resume syncing snippets."
                    />
                  </SettingsRowMain>
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    onClick={() => openStorageSetup(storageStatus.actionUrl)}
                  >
                    Reconnect
                    <ArrowUpRight />
                  </Button>
                </SettingsRow>
              ) : (
                <SettingsRow className="px-4">
                  <SettingsRowMain>
                    <SettingsRowIcon>
                      <StorageProviderIcon provider={storageStatus.provider} className="size-5" />
                    </SettingsRowIcon>
                    <SettingsRowText
                      title={`${storageProviderLabel(storageStatus.provider)} connected`}
                      description={
                        storageStatus.canSync
                          ? "Syncing snippets to this storage provider."
                          : storageStatus.account.blockedReasons.includes("billing")
                            ? "Sync paused until billing is resolved."
                            : "Sync is currently paused."
                      }
                    />
                  </SettingsRowMain>
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    onClick={() => void window.ipc.openExternal(storageStatus.destinationUrl)}
                  >
                    Open
                    <ArrowUpRight />
                  </Button>
                </SettingsRow>
              )}
            </SettingsSectionBody>
          </SettingsSection>

          <SettingsSection>
            <SettingsSectionTitle>Device storage</SettingsSectionTitle>
            <SettingsSectionBody>
              <SettingsRow className="items-start">
                <SettingsRowMain className="flex-1 items-start">
                  <HardDrive
                    className="mt-0.5 size-4 shrink-0 text-muted-foreground"
                    aria-hidden="true"
                  />
                  <SettingsRowText
                    title={`${formatFileSize(storageUsageBytes)} used by Plakk`}
                    description="Freeing space keeps your newest 20 eligible snippets available and removes older device copies only."
                    descriptionClassName="overflow-visible text-clip whitespace-normal"
                  />
                </SettingsRowMain>
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
              </SettingsRow>
              {storageFeedback !== null && (
                <p
                  className={
                    storageFeedback.kind === "failed"
                      ? "px-4 py-2 text-xs text-destructive"
                      : "px-4 py-2 text-xs text-muted-foreground"
                  }
                  role={storageFeedback.kind === "failed" ? "alert" : "status"}
                  aria-live={storageFeedback.kind === "failed" ? undefined : "polite"}
                >
                  {storageFeedback.kind === "reclaimed"
                    ? storageFeedback.reclaimedBytes > 0
                      ? `Reclaimed ${formatFileSize(storageFeedback.reclaimedBytes)} on this device.`
                      : `Removed ${storageFeedback.removedCopies} older device ${
                          storageFeedback.removedCopies === 1 ? "copy" : "copies"
                        } from this device.`
                    : storageFeedback.kind === "no-op"
                      ? "No older device copies are available to remove."
                      : storageFeedback.message}
                </p>
              )}
            </SettingsSectionBody>
          </SettingsSection>

          <SettingsSection>
            <SettingsSectionTitle>Desktop</SettingsSectionTitle>
            <SettingsSectionBody>
              <SettingsRow>
                <SettingsRowMain>
                  <SunMoon className="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
                  <SettingsRowText
                    title="Appearance"
                    description="Choose a theme or follow your system."
                  />
                </SettingsRowMain>
                <select
                  aria-label="Appearance"
                  className="h-8 rounded-md border bg-background px-2 text-sm outline-none focus-visible:ring-3 focus-visible:ring-ring/50"
                  disabled={savingAppearance}
                  value={appearance.preference}
                  onChange={(event) => {
                    setAppearanceError(null);
                    setSavingAppearance(true);
                    void setAppearancePreference(
                      event.currentTarget.value as "light" | "dark" | "system",
                    ).then(
                      () => setSavingAppearance(false),
                      () => {
                        setSavingAppearance(false);
                        setAppearanceError("Could not save the appearance setting.");
                      },
                    );
                  }}
                >
                  <option value="light">Light</option>
                  <option value="dark">Dark</option>
                  <option value="system">System</option>
                </select>
              </SettingsRow>
              {appearanceError !== null && (
                <p className="px-4 py-2 text-xs text-destructive" role="alert">
                  {appearanceError}
                </p>
              )}

              <GlobalHotkeyControl
                busy={globalHotkeyBusy}
                error={globalHotkeyError}
                isRecording={recorder.isRecording}
                onBeginRecording={() => void beginGlobalHotkeyRecording()}
                onCancelRecording={recorder.cancelRecording}
                onUpdate={(patch) => void updateGlobalHotkey(patch)}
                status={globalHotkeyStatus}
              />

              <SettingsRow>
                <SettingsRowMain>
                  <SquareMenu
                    className="size-4 shrink-0 text-muted-foreground"
                    aria-hidden="true"
                  />
                  <SettingsRowText
                    title="Toolbar widget"
                    description="Show quick access from the desktop toolbar."
                  />
                </SettingsRowMain>
                <Switch checked={toolbarWidget} onCheckedChange={setToolbarWidget} />
              </SettingsRow>
            </SettingsSectionBody>
          </SettingsSection>

          <SettingsSection>
            <SettingsSectionTitle>App</SettingsSectionTitle>
            <SettingsSectionBody>
              <SettingsRow>
                <SettingsRowMain>
                  <RefreshCw className="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
                  <SettingsRowText title="Plakk Desktop 0.1.0" description={updateStatus} />
                </SettingsRowMain>
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={() => setUpdateStatus("Checked just now")}
                >
                  Check
                </Button>
              </SettingsRow>

              <SettingsRow>
                <SettingsRowText
                  title="Auto update"
                  description="Install updates in the background."
                />
                <Switch checked={autoUpdate} onCheckedChange={setAutoUpdate} />
              </SettingsRow>

              <SettingsRow>
                <SettingsRowMain>
                  <FileText className="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
                  <SettingsRowText title="Logs" description="Open diagnostic files." />
                </SettingsRowMain>
                <Button type="button" variant="outline" size="sm">
                  Open
                </Button>
              </SettingsRow>
            </SettingsSectionBody>
          </SettingsSection>

          <SettingsSection>
            <SettingsSectionTitle>Help</SettingsSectionTitle>
            <SettingsSectionBody>
              <SettingsRow>
                <SettingsRowMain>
                  <MessageCircle
                    className="size-4 shrink-0 text-muted-foreground"
                    aria-hidden="true"
                  />
                  <SettingsRowText title="Contact us" description="Get help from the Plakk team." />
                </SettingsRowMain>
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={() => void window.ipc.openExternal("https://app.plakk.io/contact")}
                >
                  Open
                </Button>
              </SettingsRow>
              <SettingsRow>
                <SettingsRowMain>
                  <MessageCircle
                    className="size-4 shrink-0 text-muted-foreground"
                    aria-hidden="true"
                  />
                  <SettingsRowText
                    title="Give feedback"
                    description="Share what is working or missing."
                  />
                </SettingsRowMain>
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={() => void window.ipc.openExternal("https://app.plakk.io/feedback")}
                >
                  Open
                </Button>
              </SettingsRow>
            </SettingsSectionBody>
          </SettingsSection>
        </div>
      </div>
    </main>
  );
}
