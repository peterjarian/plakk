import { Check, CloudOff, LoaderCircle, Pause } from "lucide-react";

export type SyncStatus = "CHECKING" | "CONNECTED" | "OFFLINE" | "PAUSED" | "RECONNECTING";

const presentations = {
  CHECKING: { Icon: LoaderCircle, label: "Checking", className: "animate-spin" },
  CONNECTED: { Icon: Check, label: "Synced", className: "text-emerald-500" },
  OFFLINE: { Icon: CloudOff, label: "Offline", className: "" },
  PAUSED: { Icon: Pause, label: "Paused", className: "" },
  RECONNECTING: { Icon: LoaderCircle, label: "Reconnecting", className: "animate-spin" },
} as const;

export function SyncStatusIndicator({ status }: { readonly status: SyncStatus }) {
  const { Icon, className, label } = presentations[status];
  return (
    <span className="flex items-center gap-1.5 text-xs text-muted-foreground">
      <Icon className={`size-3.5 ${className}`} aria-hidden="true" />
      <span>{label}</span>
    </span>
  );
}
