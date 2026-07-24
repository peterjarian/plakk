import type { ComponentProps, ReactNode } from "react";

import { cn } from "@plakk/ui/lib/utils";

function SettingsSection({ className, ...props }: ComponentProps<"div">) {
  return <div className={cn("grid gap-2", className)} {...props} />;
}

function SettingsSectionTitle({ className, ...props }: ComponentProps<"h2">) {
  return (
    <h2
      className={cn("text-xs font-medium tracking-wide text-muted-foreground uppercase", className)}
      {...props}
    />
  );
}

function SettingsSectionBody({ className, ...props }: ComponentProps<"section">) {
  return (
    <section
      className={cn("divide-y overflow-hidden rounded-lg border bg-card", className)}
      {...props}
    />
  );
}

function SettingsRow({ className, ...props }: ComponentProps<"div">) {
  return (
    <div
      className={cn("flex items-center justify-between gap-4 px-3 py-3", className)}
      {...props}
    />
  );
}

function SettingsRowMain({ className, ...props }: ComponentProps<"div">) {
  return <div className={cn("flex min-w-0 items-center gap-3", className)} {...props} />;
}

function SettingsRowIcon({ className, children, ...props }: ComponentProps<"span">) {
  return (
    <span className={cn("flex w-10 shrink-0 justify-center", className)} {...props}>
      {children}
    </span>
  );
}

function SettingsRowText({
  title,
  description,
  descriptionClassName,
  className,
  ...props
}: ComponentProps<"div"> & {
  title: ReactNode;
  description?: ReactNode;
  descriptionClassName?: string;
}) {
  return (
    <div className={cn("min-w-0", className)} {...props}>
      <h3 className="truncate text-sm font-semibold">{title}</h3>
      {description ? (
        <p className={cn("truncate text-xs text-muted-foreground", descriptionClassName)}>
          {description}
        </p>
      ) : null}
    </div>
  );
}

function SettingsRowAction({ className, ...props }: ComponentProps<"div">) {
  return <div className={cn("flex shrink-0 items-center gap-2", className)} {...props} />;
}

export {
  SettingsRow,
  SettingsRowAction,
  SettingsRowIcon,
  SettingsRowMain,
  SettingsRowText,
  SettingsSection,
  SettingsSectionBody,
  SettingsSectionTitle,
};
