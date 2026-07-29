import type { ComponentProps, ReactNode } from "react";

import { cn } from "@plakk/ui/lib/utils";

export type SettingsSectionProps = ComponentProps<"div">;

function SettingsSection({ className, ...props }: SettingsSectionProps) {
  return <div data-slot="settings-section" className={cn("grid gap-2", className)} {...props} />;
}

export type SettingsSectionTitleProps = ComponentProps<"h2">;

function SettingsSectionTitle({ className, ...props }: SettingsSectionTitleProps) {
  return (
    <h2
      data-slot="settings-section-title"
      className={cn("text-xs font-medium tracking-wide text-muted-foreground uppercase", className)}
      {...props}
    />
  );
}

export type SettingsSectionBodyProps = ComponentProps<"section">;

function SettingsSectionBody({ className, ...props }: SettingsSectionBodyProps) {
  return (
    <section
      data-slot="settings-section-body"
      className={cn("divide-y overflow-hidden rounded-lg border bg-card", className)}
      {...props}
    />
  );
}

export type SettingsRowProps = ComponentProps<"div">;

function SettingsRow({ className, ...props }: SettingsRowProps) {
  return (
    <div
      data-slot="settings-row"
      className={cn("flex items-center justify-between gap-4 px-3 py-3", className)}
      {...props}
    />
  );
}

export type SettingsRowMainProps = ComponentProps<"div">;

function SettingsRowMain({ className, ...props }: SettingsRowMainProps) {
  return (
    <div
      data-slot="settings-row-main"
      className={cn("flex min-w-0 items-center gap-3", className)}
      {...props}
    />
  );
}

export type SettingsRowIconProps = ComponentProps<"span">;

function SettingsRowIcon({ className, children, ...props }: SettingsRowIconProps) {
  return (
    <span
      data-slot="settings-row-icon"
      className={cn("flex w-10 shrink-0 justify-center", className)}
      {...props}
    >
      {children}
    </span>
  );
}

export type SettingsRowTextProps = ComponentProps<"div"> & {
  title: ReactNode;
  description?: ReactNode;
  descriptionClassName?: string;
};

function SettingsRowText({
  title,
  description,
  descriptionClassName,
  className,
  ...props
}: SettingsRowTextProps) {
  return (
    <div data-slot="settings-row-text" className={cn("min-w-0", className)} {...props}>
      <h3 className="truncate text-sm font-semibold">{title}</h3>
      {description ? (
        <p className={cn("truncate text-xs text-muted-foreground", descriptionClassName)}>
          {description}
        </p>
      ) : null}
    </div>
  );
}

export type SettingsRowActionProps = ComponentProps<"div">;

function SettingsRowAction({ className, ...props }: SettingsRowActionProps) {
  return (
    <div
      data-slot="settings-row-action"
      className={cn("flex shrink-0 items-center gap-2", className)}
      {...props}
    />
  );
}

export const Settings = {
  Section: SettingsSection,
  SectionTitle: SettingsSectionTitle,
  SectionBody: SettingsSectionBody,
  Row: SettingsRow,
  RowMain: SettingsRowMain,
  RowIcon: SettingsRowIcon,
  RowText: SettingsRowText,
  RowAction: SettingsRowAction,
};
