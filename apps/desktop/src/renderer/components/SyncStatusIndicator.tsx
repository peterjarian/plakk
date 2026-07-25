import { Tooltip, TooltipContent, TooltipTrigger } from "@plakk/ui/components/primitives/tooltip";

export type SyncStatus = "CHECKING" | "CONNECTED" | "OFFLINE" | "PAUSED" | "RECONNECTING";

const presentation = {
  CHECKING: {
    label: "Checking connection",
    dotClassName: "animate-pulse bg-muted-foreground/40",
  },
  CONNECTED: {
    label: "Up to date",
    dotClassName: "bg-emerald-500/80",
  },
  OFFLINE: {
    label: "Offline",
    dotClassName: "bg-muted-foreground/50",
  },
  PAUSED: {
    label: "Sync paused",
    dotClassName: "bg-amber-500/80",
  },
  RECONNECTING: {
    label: "Reconnecting",
    dotClassName: "animate-pulse bg-amber-500/80",
  },
} satisfies Record<SyncStatus, { readonly dotClassName: string; readonly label: string }>;

export function SyncStatusIndicator({ status }: { readonly status: SyncStatus }) {
  const { dotClassName, label } = presentation[status];

  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <span
            className="no-drag inline-flex size-4 items-center justify-center rounded-full outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
            role="status"
            aria-label={label}
            tabIndex={0}
          />
        }
      >
        <span className={`size-1.5 rounded-full ${dotClassName}`} aria-hidden="true" />
      </TooltipTrigger>
      <TooltipContent>{label}</TooltipContent>
    </Tooltip>
  );
}
