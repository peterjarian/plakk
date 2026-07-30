import { CircleAlert, Info, TriangleAlert } from "lucide-react";
import type { ComponentProps, ReactNode } from "react";

import { cn } from "@plakk/ui/lib/utils";

export type ProductNoticeTone = "info" | "warning" | "danger";

export type ProductNoticeProps = Omit<ComponentProps<"div">, "title"> & {
  readonly tone?: ProductNoticeTone;
  readonly title?: ReactNode;
  readonly action?: ReactNode;
};

const toneStyles: Record<
  ProductNoticeTone,
  { readonly container: string; readonly icon: string; readonly Icon: typeof Info }
> = {
  info: {
    container: "border-border bg-muted/50",
    icon: "text-muted-foreground",
    Icon: Info,
  },
  warning: {
    container: "border-amber-500/20 bg-amber-500/10",
    icon: "text-amber-600 dark:text-amber-400",
    Icon: TriangleAlert,
  },
  danger: {
    container: "border-destructive/20 bg-destructive/8",
    icon: "text-destructive",
    Icon: CircleAlert,
  },
};

export function ProductNotice({
  tone = "info",
  title,
  action,
  className,
  children,
  role,
  ...props
}: ProductNoticeProps) {
  const { container, icon, Icon } = toneStyles[tone];
  const resolvedRole = role ?? (tone === "danger" ? "alert" : "status");

  return (
    <div
      data-slot="product-notice"
      data-tone={tone}
      role={resolvedRole}
      aria-live={resolvedRole === "status" ? "polite" : undefined}
      className={cn(
        "flex min-w-0 items-start gap-2.5 rounded-lg border px-3 py-2.5 text-xs text-foreground",
        container,
        className,
      )}
      {...props}
    >
      <Icon className={cn("mt-0.5 size-4 shrink-0", icon)} aria-hidden="true" />
      <div className="min-w-0 flex-1">
        {title !== undefined && <p className="font-medium">{title}</p>}
        {children !== undefined && (
          <div className={cn("text-muted-foreground", title !== undefined && "mt-0.5")}>
            {children}
          </div>
        )}
      </div>
      {action !== undefined && <div className="-my-1 shrink-0">{action}</div>}
    </div>
  );
}
