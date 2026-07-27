import type { User } from "@plakk/shared";
import { formatAccountBillingInstant, type AccountAccessEntitlement } from "@plakk/shared/PlakkApi";
import { AppHeader } from "@plakk/ui/components/AppHeader";
import { Button, buttonVariants } from "@plakk/ui/components/primitives/button";
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
  SettingsRowAction,
  SettingsRowMain,
  SettingsRowText,
  SettingsSection,
  SettingsSectionBody,
  SettingsSectionTitle,
} from "@plakk/ui/components/settings";
import {
  ArrowLeft,
  CircleHelp,
  CreditCard,
  HardDrive,
  LogOut,
  Mail,
  SunMoon,
  UserRound,
} from "lucide-react";

import type { AccountProductState } from "./account-product-lifetime.ts";
import { storageProviderLabel } from "./storage-provider-presentation.ts";
import type { WebAppearancePreference } from "./web-appearance.tsx";

const appearanceLabels: Record<WebAppearancePreference, string> = {
  dark: "Dark",
  light: "Light",
  system: "System",
};

const billingPresentation = (entitlement: AccountAccessEntitlement) => {
  switch (entitlement.status) {
    case "TRIAL_ACTIVE":
      return {
        action: "Upgrade",
        description: `Your trial ends exactly ${formatAccountBillingInstant(entitlement.trialEndsAt)}. Billing starts immediately; subscribing permanently ends unused trial time.`,
        title: "Trial active",
      };
    case "PAID_ACTIVE":
      return {
        action: "Manage billing",
        description: `${entitlement.cancelAtPeriodEnd ? "Access remains active" : "Paid access is active"} through ${formatAccountBillingInstant(entitlement.paidThrough)}.`,
        title: entitlement.cancelAtPeriodEnd ? "Subscription canceled" : "Paid access active",
      };
    case "GRACE_ACTIVE":
      return {
        action: "Recover billing",
        description: `Normal use continues through ${formatAccountBillingInstant(entitlement.graceEndsAt)}. Update payment before then.`,
        title: "Payment needs attention",
      };
    case "BILLING_RESTRICTED":
      return {
        action: "Restore billing",
        description:
          "Your snippets and provider content are preserved. Restore billing to resume Add, Copy, Download, and Open.",
        title: "Billing access required",
      };
  }
};

export function SettingsView(props: {
  readonly appearance: WebAppearancePreference;
  readonly onAppearanceChange: (preference: WebAppearancePreference) => void;
  readonly onBack: () => void;
  readonly onBilling: () => void;
  readonly onSignOut: () => void;
  readonly onStorage: () => void;
  readonly state: AccountProductState;
  readonly user: User;
}) {
  const { appearance, onAppearanceChange, onBack, onBilling, onSignOut, onStorage, state, user } =
    props;
  const account = state.kind === "ready" ? state.account : null;
  const billing = account === null ? null : billingPresentation(account.accessEntitlement);
  const displayName =
    [user.firstName, user.lastName].filter(Boolean).join(" ") || user.email || user.id;
  const storageTitle =
    state.kind === "failed"
      ? "Storage status unavailable"
      : account === null
        ? "Loading connected storage"
        : account.storageProvider === null
          ? "No storage connected"
          : account.blockedReasons.includes("storage")
            ? `${storageProviderLabel(account.storageProvider)} needs reconnection`
            : `${storageProviderLabel(account.storageProvider)} connected`;
  const storageAction =
    account?.storageProvider === null
      ? "Connect storage"
      : account?.blockedReasons.includes("storage")
        ? "Reconnect storage"
        : "Manage storage";

  return (
    <main className="flex min-h-screen flex-col bg-background text-foreground">
      <AppHeader
        className="h-14 border-b border-border"
        user={user}
        onSignOutClick={onSignOut}
        storageAction={<span className="text-xs text-muted-foreground">Settings</span>}
      />
      <div className="mx-auto grid w-full max-w-2xl gap-7 px-4 py-6 sm:px-6 sm:py-8">
        <Button type="button" variant="ghost" size="sm" className="-ml-2 w-fit" onClick={onBack}>
          <ArrowLeft />
          Back to Home
        </Button>

        <div>
          <p className="text-xs font-medium tracking-wide text-muted-foreground uppercase">
            Settings
          </p>
          <h1 className="text-2xl font-semibold tracking-tight">Your account</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            Manage the parts of Plakk that apply in this browser.
          </p>
        </div>

        <SettingsSection>
          <SettingsSectionTitle>Account</SettingsSectionTitle>
          <SettingsSectionBody>
            <SettingsRow>
              <SettingsRowMain>
                <UserRound className="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
                <SettingsRowText title={displayName} description={user.email ?? user.id} />
              </SettingsRowMain>
            </SettingsRow>
            <SettingsRow>
              <SettingsRowMain>
                <LogOut className="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
                <SettingsRowText
                  title="Sign out"
                  description="Clear this account’s Web product data before ending the session."
                />
              </SettingsRowMain>
              <Button type="button" variant="outline" size="sm" onClick={onSignOut}>
                Sign out
              </Button>
            </SettingsRow>
          </SettingsSectionBody>
        </SettingsSection>

        <SettingsSection>
          <SettingsSectionTitle>Billing</SettingsSectionTitle>
          <SettingsSectionBody>
            <SettingsRow className="items-start">
              <SettingsRowMain className="items-start">
                <CreditCard
                  className="mt-0.5 size-4 shrink-0 text-muted-foreground"
                  aria-hidden="true"
                />
                <SettingsRowText
                  title={billing?.title ?? "Loading billing status"}
                  description={
                    billing?.description ?? "Reading backend-confirmed account billing status."
                  }
                  descriptionClassName="overflow-visible text-clip whitespace-normal"
                />
              </SettingsRowMain>
              {billing !== null && (
                <Button type="button" variant="outline" size="sm" onClick={onBilling}>
                  {billing.action}
                </Button>
              )}
            </SettingsRow>
          </SettingsSectionBody>
        </SettingsSection>

        <SettingsSection>
          <SettingsSectionTitle>Connected storage</SettingsSectionTitle>
          <SettingsSectionBody>
            <SettingsRow className="items-start">
              <SettingsRowMain className="items-start">
                <HardDrive
                  className="mt-0.5 size-4 shrink-0 text-muted-foreground"
                  aria-hidden="true"
                />
                <SettingsRowText
                  title={storageTitle}
                  description={
                    state.kind === "failed"
                      ? "Plakk could not read authoritative connected-storage state. Return Home and try again."
                      : account === null
                        ? "Reading authoritative connected-storage state."
                        : account.blockedReasons.includes("storage")
                          ? `Storage recovery remains independent of billing recovery.${account.blockedReasons.includes("billing") ? " Restore both blockers before provider actions resume." : ""}`
                          : "Reconnect, unlink, or switch this account’s provider."
                  }
                  descriptionClassName="overflow-visible text-clip whitespace-normal"
                />
              </SettingsRowMain>
              {account !== null && (
                <Button type="button" variant="outline" size="sm" onClick={onStorage}>
                  {storageAction}
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
                <SunMoon className="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
                <SettingsRowText
                  title="Appearance"
                  description="Choose a theme or follow this browser’s system preference."
                />
              </SettingsRowMain>
              <SettingsRowAction>
                <Select
                  value={appearance}
                  onValueChange={(value) => {
                    if (value === "dark" || value === "light" || value === "system") {
                      onAppearanceChange(value);
                    }
                  }}
                >
                  <SelectTrigger aria-label="Appearance">
                    <SelectValue>{appearanceLabels[appearance]}</SelectValue>
                  </SelectTrigger>
                  <SelectContent align="end">
                    <SelectGroup>
                      <SelectItem value="light">Light</SelectItem>
                      <SelectItem value="dark">Dark</SelectItem>
                      <SelectItem value="system">System</SelectItem>
                    </SelectGroup>
                  </SelectContent>
                </Select>
              </SettingsRowAction>
            </SettingsRow>
          </SettingsSectionBody>
        </SettingsSection>

        <SettingsSection>
          <SettingsSectionTitle>Help</SettingsSectionTitle>
          <SettingsSectionBody>
            <SettingsRow>
              <SettingsRowMain>
                <CircleHelp className="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
                <SettingsRowText
                  title="Contact Plakk help"
                  description="Get help with your account, billing, storage, or Snippets."
                />
              </SettingsRowMain>
              <a
                className={buttonVariants({ size: "sm", variant: "outline" })}
                href="mailto:help@plakk.io"
              >
                <Mail />
                Email help
              </a>
            </SettingsRow>
          </SettingsSectionBody>
        </SettingsSection>
      </div>
    </main>
  );
}
