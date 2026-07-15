import { formatFileSize, type SnippetKind } from "@plakk/shared";
import type { ApiSnippet } from "@plakk/shared/PlakkApi";
import type { LocalTextSnippet } from "@plakk/shared/SnippetReplica";
import * as DateTime from "effect/DateTime";
import {
  ArrowUpRight,
  Check,
  CloudUpload,
  Copy,
  FileText,
  ImageIcon,
  LoaderCircle,
  LinkIcon,
  RotateCw,
  Trash2,
  Type,
  X,
} from "lucide-react";
import type { UploadTask } from "../atoms/upload.ts";
import { Button } from "./primitives/button.tsx";

export type SnippetRowItem = ApiSnippet | UploadTask | LocalTextSnippet;

export type TextSnippetContent =
  | { readonly state: "loading" }
  | { readonly state: "ready"; readonly text: string }
  | { readonly state: "failed"; readonly message: string };

const kindMeta: Record<SnippetKind, { Icon: typeof Type }> = {
  TEXT: { Icon: Type },
  LINK: { Icon: LinkIcon },
  FILE: { Icon: FileText },
  IMAGE: { Icon: ImageIcon },
};

const isRendererUpload = (snippet: SnippetRowItem): snippet is UploadTask =>
  "phase" in snippet && !("createdAt" in snippet);

const isLocalText = (snippet: SnippetRowItem): snippet is LocalTextSnippet =>
  "phase" in snippet && "createdAt" in snippet;

const fileSubtitle = (snippet: Pick<ApiSnippet, "byteSize" | "fileName" | "kind">) =>
  `${snippet.fileName.split(".").pop()?.toUpperCase() ?? snippet.kind} · ${formatFileSize(snippet.byteSize)}`;

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
  now: number;
  copied: boolean;
  onCopy: () => void;
  onDelete: () => void;
  onOpenLink?: (url: string) => void;
  onRetryContent?: () => void;
  onRetryUpload?: () => void;
  onStopUpload: () => void;
  textContent?: TextSnippetContent;
  thumbnailUrl?: string | null;
  copyDisabled?: boolean;
  copying?: boolean;
  copyError?: string;
  showActions?: boolean;
}) {
  const {
    snippet,
    now,
    copied,
    onCopy,
    onDelete,
    onOpenLink,
    onRetryContent,
    onRetryUpload,
    onStopUpload,
    textContent,
    thumbnailUrl,
    copyDisabled = false,
    copying = false,
    copyError,
    showActions = true,
  } = props;
  const { Icon } = kindMeta[snippet.kind];
  const isQueued = isLocalText(snippet) && snippet.phase === "QUEUED";
  const isUploading =
    isQueued ||
    (isRendererUpload(snippet) && snippet.phase !== "FAILED") ||
    (!("phase" in snippet) && snippet.uploadStatus === "UPLOADING");
  const title =
    snippet.kind === "TEXT"
      ? textContent?.state === "ready"
        ? textContent.text
        : "phase" in snippet
          ? "Text snippet"
          : snippet.title
      : "phase" in snippet
        ? snippet.fileName
        : snippet.title;
  const subtitle =
    isRendererUpload(snippet) && snippet.phase === "FAILED"
      ? (snippet.errorMessage ?? "Upload failed. Choose the file again to retry.")
      : isLocalText(snippet) && snippet.phase === "NEEDS_ACTION"
        ? (snippet.errorMessage ?? "This snippet needs attention before it can sync.")
        : isQueued
          ? "Saved on this Mac — syncs automatically"
          : !("phase" in snippet) && snippet.uploadStatus === "UPLOADING"
            ? "Uploading to connected storage…"
            : !("phase" in snippet) && snippet.uploadStatus === "INTERRUPTED"
              ? "Upload interrupted — waiting for the source device"
              : !("phase" in snippet) && snippet.uploadStatus === "FAILED"
                ? (snippet.uploadFailureMessage ?? "Upload needs attention on the source device.")
                : snippet.kind === "TEXT" && textContent?.state === "loading"
                  ? "Loading text…"
                  : snippet.kind === "TEXT" && textContent?.state === "failed"
                    ? textContent.message
                    : snippet.kind === "FILE" || snippet.kind === "IMAGE"
                      ? fileSubtitle(snippet)
                      : "phase" in snippet
                        ? ""
                        : formatFileSize(snippet.byteSize);
  const time =
    "phase" in snippet
      ? snippet.phase === "FAILED"
        ? "Failed"
        : snippet.phase === "NEEDS_ACTION"
          ? "Needs attention"
          : snippet.phase === "QUEUED"
            ? "Queued"
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
          {snippet.kind === "IMAGE" && thumbnailUrl !== null && thumbnailUrl !== undefined ? (
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
          {isUploading ? (
            <div className="flex items-center gap-1">
              {isQueued ? (
                <CloudUpload
                  className="size-4 text-muted-foreground"
                  aria-label="Saved locally; syncs automatically"
                />
              ) : (
                <LoaderCircle
                  className="size-4 animate-spin text-muted-foreground"
                  aria-label="Uploading"
                />
              )}
              {showActions && "phase" in snippet && (
                <Button
                  type="button"
                  variant="ghost"
                  size="icon-sm"
                  aria-label={isQueued ? "Remove queued snippet" : "Stop uploading"}
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
                {((isRendererUpload(snippet) && snippet.phase === "FAILED") ||
                  (isLocalText(snippet) && snippet.phase === "NEEDS_ACTION")) &&
                  onRetryUpload && (
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
                {snippet.kind === "TEXT" && textContent?.state === "failed" && onRetryContent && (
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon-sm"
                    aria-label="Retry loading text"
                    onClick={onRetryContent}
                  >
                    <RotateCw />
                  </Button>
                )}
                <Button
                  type="button"
                  variant="ghost"
                  size="icon-sm"
                  aria-label={copying ? "Copying" : copied ? "Copied" : "Copy"}
                  disabled={
                    copying ||
                    copyDisabled ||
                    (snippet.kind === "TEXT" && textContent?.state !== "ready")
                  }
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
                {snippet.kind === "LINK" && (
                  <>
                    {onOpenLink ? (
                      <Button
                        type="button"
                        variant="ghost"
                        size="icon-sm"
                        aria-label="Open link"
                        onClick={() => onOpenLink(title)}
                      >
                        <ArrowUpRight />
                      </Button>
                    ) : (
                      <Button
                        render={<a href={title} target="_blank" rel="noreferrer" />}
                        variant="ghost"
                        size="icon-sm"
                        aria-label="Open link"
                      >
                        <ArrowUpRight />
                      </Button>
                    )}
                  </>
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
