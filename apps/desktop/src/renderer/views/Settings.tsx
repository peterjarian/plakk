import { useState } from "react";
import {
  ArrowLeft,
  ArrowUpRight,
  CloudOff,
  CreditCard,
  FileText,
  Keyboard,
  MessageCircle,
  RefreshCw,
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
import { useAuth } from "../hooks/useAuth.ts";
import {
  StorageProviderIcon,
  storageProviderLabel,
  openStorageSetup,
  useStorageStatus,
} from "../hooks/useStorageStatus.tsx";
import { navigate } from "../lib/navigate.ts";

export function Settings() {
  const auth = useAuth();
  const storageStatus = useStorageStatus();
  const [autoUpdate, setAutoUpdate] = useState(true);
  const [globalHotkey, setGlobalHotkey] = useState(true);
  const [toolbarWidget, setToolbarWidget] = useState(true);
  const [updateStatus, setUpdateStatus] = useState("Up to date");
  const user = auth.user;

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
                          : storageStatus.kind === "offline" && storageStatus.provider !== null
                            ? `${storageProviderLabel(storageStatus.provider)} linked`
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
            <SettingsSectionTitle>Desktop</SettingsSectionTitle>
            <SettingsSectionBody>
              <SettingsRow>
                <SettingsRowMain>
                  <Keyboard className="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
                  <SettingsRowText title="Global hotkey" description="Open Plakk from anywhere." />
                </SettingsRowMain>
                <SettingsRowAction>
                  <select
                    className="h-7 rounded-md border bg-background px-2 text-sm outline-none focus-visible:ring-3 focus-visible:ring-ring/50"
                    disabled={!globalHotkey}
                    defaultValue="CommandOrControl+Shift+V"
                  >
                    <option value="CommandOrControl+Shift+V">⌘⇧V</option>
                    <option value="CommandOrControl+Shift+Space">⌘⇧Space</option>
                    <option value="CommandOrControl+Option+V">⌘⌥V</option>
                  </select>
                  <Switch checked={globalHotkey} onCheckedChange={setGlobalHotkey} />
                </SettingsRowAction>
              </SettingsRow>

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
