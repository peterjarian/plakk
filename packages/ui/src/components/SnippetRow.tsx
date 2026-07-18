import { formatFileSize, type SnippetPresentation } from "@plakk/shared";
import type { ApiSnippet } from "@plakk/shared/PlakkApi";
import type { LocalContentAvailability } from "@plakk/shared/SnippetHydration";
import * as DateTime from "effect/DateTime";
import {
  ArrowUpRight,
  Check,
  Copy,
  Download,
  FileText,
  ImageIcon,
  LoaderCircle,
  LinkIcon,
  RotateCw,
  Trash2,
  Type,
  X,
} from "lucide-react";
import { Button } from "./primitives/button.tsx";

export type SnippetRowItem = Omit<ApiSnippet, "storageObjectId" | "uploadStatus"> & {
  readonly uploadStatus: ApiSnippet["uploadStatus"] | null;
  readonly localState: null | {
    readonly phase: "IMPORTING" | "QUEUED" | "UPLOADING" | "FAILED";
    readonly progress: number;
    readonly errorMessage: string | null;
    readonly canRetry: boolean;
  };
  readonly localContentAvailability: LocalContentAvailability;
};

const presentationMeta: Record<SnippetPresentation["type"], { Icon: typeof Type }> = {
  text: { Icon: Type },
  hyperlink: { Icon: LinkIcon },
  file: { Icon: FileText },
  image: { Icon: ImageIcon },
};

const fileSubtitle = (snippet: Pick<ApiSnippet, "byteSize" | "fileName">) =>
  `${snippet.fileName.split(".").pop()?.toUpperCase() ?? "FILE"} · ${formatFileSize(snippet.byteSize)}`;

const relativeDateUnits = [
  [30 * 24 * 60 * 60 * 1000, "month"],
  [7 * 24 * 60 * 60 * 1000, "week"],
  [24 * 60 * 60 * 1000, "day"],
  [60 * 60 * 1000, "hour"],
  [60 * 1000, "minute"],
] as const;
const yearMilliseconds = 365 * 24 * 60 * 60 * 1000;

const formatRelativeDate = (value: number, unit: string, future: boolean) => {
  const quantity = Math.abs(value);
  const label = quantity === 1 ? `${unit === "hour" ? "an" : "a"} ${unit}` : `${quantity} ${unit}s`;
  return future ? `in ${label}` : `${label} ago`;
};

export function formatSnippetDate(
  createdAt: string,
  now = DateTime.toEpochMillis(DateTime.nowUnsafe()),
): string {
  const timestamp = Date.parse(createdAt);
  if (Number.isNaN(timestamp)) return createdAt.slice(0, 10);

  const difference = now - timestamp;
  const absoluteDifference = Math.abs(difference);
  if (absoluteDifference < 60 * 1000) return "just now";
  if (absoluteDifference >= yearMilliseconds) return createdAt.slice(0, 10);

  for (const [unitMilliseconds, unit] of relativeDateUnits) {
    if (absoluteDifference < unitMilliseconds) continue;
    return formatRelativeDate(
      Math.floor(absoluteDifference / unitMilliseconds),
      unit,
      difference < 0,
    );
  }

  return createdAt.slice(0, 10);
}

export function SnippetRow(props: {
  snippet: SnippetRowItem;
  presentation: SnippetPresentation;
  now: number;
  copied: boolean;
  onCopy: () => void;
  onDelete: () => void;
  onDownload?: () => void;
  onOpenLink?: (url: string) => void;
  onRetryUpload?: () => void;
  onStopUpload: () => void;
  thumbnailUrl?: string | null;
  copyDisabled?: boolean;
  copying?: boolean;
  copyError?: string;
  showActions?: boolean;
}) {
  const {
    snippet,
    presentation,
    now,
    copied,
    onCopy,
    onDelete,
    onDownload,
    onOpenLink,
    onRetryUpload,
    onStopUpload,
    thumbnailUrl,
    copyDisabled = false,
    copying = false,
    copyError,
    showActions = true,
  } = props;
  const { Icon } = presentationMeta[presentation.type];
  const localState = snippet.localState;
  const isRemoteUploading = localState === null && snippet.uploadStatus === "UPLOADING";
  const isRemoteFailed = localState === null && snippet.uploadStatus === "FAILED";
  const isUploading = isRemoteUploading || (localState !== null && localState.phase !== "FAILED");
  const isDownloading = snippet.localContentAvailability.status === "DOWNLOADING";
  const needsDownload =
    snippet.uploadStatus === "UPLOADED" &&
    (snippet.localContentAvailability.status === "NOT_AVAILABLE" ||
      snippet.localContentAvailability.status === "FAILED");
  const isAvailableOffline =
    snippet.uploadStatus === "UPLOADED" && snippet.localContentAvailability.status === "AVAILABLE";
  const canStopUpload = localState !== null && localState.phase !== "FAILED";
  const title = presentation.title;
  const subtitle =
    copyError !== undefined
      ? copyError
      : isRemoteFailed
        ? "Upload failed on the origin device."
        : localState?.phase === "FAILED"
          ? (localState.errorMessage ?? "Upload failed. Choose the file again to retry.")
          : snippet.localContentAvailability.status === "FAILED"
            ? snippet.localContentAvailability.message
            : isDownloading
              ? "Downloading for offline access…"
              : localState?.phase === "IMPORTING"
                ? "Saving locally…"
                : presentation.type === "file" || presentation.type === "image"
                  ? `${fileSubtitle(snippet)}${isAvailableOffline ? " · Available offline" : snippet.localContentAvailability.status === "NOT_AVAILABLE" ? " · Not on this device" : ""}`
                  : snippet.localContentAvailability.status === "NOT_AVAILABLE" &&
                      snippet.uploadStatus === "UPLOADED"
                    ? "Not on this device"
                    : isAvailableOffline
                      ? `Available offline · ${formatFileSize(snippet.byteSize)}`
                      : localState !== null
                        ? ""
                        : formatFileSize(snippet.byteSize);
  const time = isRemoteFailed
    ? "Failed"
    : localState !== null
      ? localState.phase === "FAILED"
        ? "Failed"
        : ""
      : formatSnippetDate(snippet.createdAt, now);

  return (
    <li>
      <div
        data-snippet-row=""
        tabIndex={0}
        className="group relative flex items-center gap-2.5 rounded-lg px-2 py-2 transition-colors outline-none select-none hover:bg-muted/60 focus-visible:ring-3 focus-visible:ring-ring/50 focus-visible:ring-offset-1 focus-visible:ring-offset-background focus-visible:outline-none focus-within:bg-muted/60"
      >
        <span className="flex size-8 shrink-0 items-center justify-center overflow-hidden rounded-md bg-muted text-muted-foreground">
          {presentation.type === "image" && thumbnailUrl !== null && thumbnailUrl !== undefined ? (
            <img src={thumbnailUrl} alt="" className="size-full object-cover" />
          ) : (
            <Icon className="size-4" />
          )}
        </span>

        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-medium">{title}</p>
          {subtitle && <p className="truncate text-xs text-muted-foreground">{subtitle}</p>}
        </div>

        <div className="flex shrink-0 items-center justify-end">
          {isUploading || isDownloading ? (
            <div
              className="flex items-center gap-1"
              role="status"
              aria-label={
                isDownloading
                  ? "Downloading for offline access"
                  : localState?.phase === "IMPORTING"
                    ? "Saving locally"
                    : "Syncing"
              }
            >
              <LoaderCircle
                className="size-4 animate-spin text-muted-foreground"
                aria-hidden="true"
              />
              {showActions && canStopUpload && (
                <Button
                  type="button"
                  variant="ghost"
                  size="icon-sm"
                  aria-label={localState.phase === "IMPORTING" ? "Stop saving" : "Stop uploading"}
                  className="text-muted-foreground hover:bg-destructive/10 hover:text-destructive"
                  onClick={onStopUpload}
                >
                  <X />
                </Button>
              )}
            </div>
          ) : (
            <>
              <span
                className={`text-[11px] tabular-nums text-muted-foreground ${showActions ? "group-hover:hidden group-focus-within:hidden" : ""}`}
              >
                {time}
              </span>

              <div
                className={
                  showActions
                    ? "hidden items-center gap-0.5 group-hover:flex group-focus-within:flex"
                    : "hidden"
                }
              >
                {localState?.phase === "FAILED" && localState.canRetry && onRetryUpload && (
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon-sm"
                    aria-label="Retry upload"
                    onClick={onRetryUpload}
                  >
                    <RotateCw />
                  </Button>
                )}
                {needsDownload && onDownload && (
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon-sm"
                    aria-label={
                      snippet.localContentAvailability.status === "FAILED"
                        ? "Retry download"
                        : "Download to this device"
                    }
                    onClick={onDownload}
                  >
                    {snippet.localContentAvailability.status === "FAILED" ? (
                      <RotateCw />
                    ) : (
                      <Download />
                    )}
                  </Button>
                )}
                <Button
                  type="button"
                  variant="ghost"
                  size="icon-sm"
                  aria-label={copying ? "Copying" : copied ? "Copied" : "Copy"}
                  disabled={copying || copyDisabled}
                  onClick={onCopy}
                >
                  {copying ? (
                    <LoaderCircle className="animate-spin" />
                  ) : copied ? (
                    <Check className="text-emerald-500" />
                  ) : (
                    <Copy />
                  )}
                </Button>
                {presentation.type === "hyperlink" && onOpenLink && (
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon-sm"
                    aria-label="Open link"
                    onClick={() => onOpenLink(presentation.url)}
                  >
                    <ArrowUpRight />
                  </Button>
                )}
                <Button
                  type="button"
                  variant="ghost"
                  size="icon-sm"
                  aria-label="Delete"
                  className="hover:bg-destructive/10 hover:text-destructive"
                  onClick={onDelete}
                >
                  <Trash2 />
                </Button>
              </div>
            </>
          )}
        </div>
        {copyError && (
          <span className="sr-only" role="status">
            {copyError}
          </span>
        )}
      </div>
    </li>
  );
}
