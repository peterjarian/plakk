import { STORAGE_PROVIDERS } from "@plakk/shared";
import { Avatar, AvatarFallback } from "@plakk/ui/components/primitives/avatar";
import { Button } from "@plakk/ui/components/primitives/button";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@plakk/ui/components/primitives/select";
import {
  SettingsRow,
  SettingsRowIcon,
  SettingsRowMain,
  SettingsRowText,
  SettingsSection,
  SettingsSectionBody,
  SettingsSectionTitle,
} from "@plakk/ui/components/settings";
import { getInitials } from "@plakk/ui/lib/getInitials";
import {
  ArrowLeft,
  ArrowUpRight,
  CloudOff,
  CreditCard,
  MessageCircle,
  SunMoon,
} from "lucide-react";
import { useState } from "react";

import { StorageProviderIcon, storageProviderLabel } from "../components/StorageProviderIcon.tsx";
import type { usePlakk } from "../hooks/usePlakk.ts";
import { storageState } from "../lib/storageState.ts";

const messageFrom = (cause: unknown, fallback: string) =>
  cause instanceof Error && cause.message.trim() ? cause.message : fallback;

export function Settings(props: {
  readonly plakk: ReturnType<typeof usePlakk>;
  readonly onBack: () => void;
}) {
  const { plakk } = props;
  const [appearanceError, setAppearanceError] = useState<string | null>(null);
  const [storageError, setStorageError] = useState<string | null>(null);
  if (plakk.user === null) return null;

  const storage = storageState(plakk.capability);
  const fallback = plakk.user.email ?? plakk.user.id;
  const name = [plakk.user.firstName, plakk.user.lastName].filter(Boolean).join(" ") || fallback;

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
                onClick={() => plakk.openExternal("https://app.plakk.io/billing")}
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
                  onClick={() => plakk.openExternal(storage.destinationUrl)}
                >
                  Open
                  <ArrowUpRight />
                </Button>
              ) : storage.kind === "unlinked" ||
                (storage.kind === "offline" && storage.provider === null) ? (
                <div className="flex items-center gap-1">
                  {STORAGE_PROVIDERS.map((provider) => (
                    <Button
                      key={provider}
                      type="button"
                      variant="ghost"
                      size="icon-sm"
                      toolTip={`Connect ${storageProviderLabel(provider)}`}
                      onClick={() => {
                        setStorageError(null);
                        void plakk
                          .connectStorage(provider)
                          .catch((cause) =>
                            setStorageError(messageFrom(cause, "Could not connect storage.")),
                          );
                      }}
                    >
                      <StorageProviderIcon provider={provider} />
                      <span className="sr-only">Connect {storageProviderLabel(provider)}</span>
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
                    void plakk
                      .connectStorage(storage.provider)
                      .catch((cause) =>
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
                value={plakk.appearance}
                onValueChange={(value) => {
                  if (value === null) return;
                  setAppearanceError(null);
                  void plakk
                    .changeAppearance(value)
                    .catch(() => setAppearanceError("Could not save the appearance setting."));
                }}
              >
                <SelectTrigger aria-label="Appearance">
                  <SelectValue>
                    {plakk.appearance === "system"
                      ? "System"
                      : plakk.appearance === "dark"
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
                  onClick={() => plakk.openExternal(url!)}
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
