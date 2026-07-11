import { formatFileSize, type SnippetKind } from "@plakk/shared";
import type { ApiSnippet } from "@plakk/shared/PlakkApi";
import * as DateTime from "effect/DateTime";
import {
  ArrowUpRight,
  Check,
  Copy,
  FileText,
  ImageIcon,
  LinkIcon,
  RotateCw,
  Trash2,
  Type,
  X,
} from "lucide-react";
import type { UploadTask } from "../atoms/upload.ts";
import { Button } from "./primitives/button.tsx";

export type SnippetRowItem = ApiSnippet | UploadTask;

export type TextSnippetContent =
  | { readonly state: "loading" }
  | { readonly state: "ready"; readonly text: string; readonly migrationError?: string }
  | { readonly state: "failed"; readonly message: string };

const kindMeta: Record<SnippetKind, { Icon: typeof Type }> = {
  TEXT: { Icon: Type },
  LINK: { Icon: LinkIcon },
  FILE: { Icon: FileText },
  IMAGE: { Icon: ImageIcon },
};

const isUploadTask = (snippet: SnippetRowItem): snippet is UploadTask => "phase" in snippet;

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
  onStopUpload: () => void;
  textContent?: TextSnippetContent;
  thumbnailUrl?: string | null;
  copyDisabled?: boolean;
  copyError?: string;
}) {
  const {
    snippet,
    now,
    copied,
    onCopy,
    onDelete,
    onOpenLink,
    onRetryContent,
    onStopUpload,
    textContent,
    thumbnailUrl,
    copyDisabled = false,
    copyError,
  } = props;
  const { Icon } = kindMeta[snippet.kind];
  const uploadProgress = isUploadTask(snippet) ? snippet.progress : undefined;
  const isUploading = isUploadTask(snippet) && snippet.phase !== "FAILED";
  const title =
    snippet.kind === "TEXT"
      ? textContent?.state === "ready"
        ? textContent.text
        : isUploadTask(snippet)
          ? "Text snippet"
          : snippet.title
      : isUploadTask(snippet)
        ? snippet.fileName
        : snippet.title;
  const subtitle =
    isUploadTask(snippet) && snippet.phase === "FAILED"
      ? (snippet.errorMessage ?? "Upload failed. Choose the file again to retry.")
      : snippet.kind === "TEXT" && textContent?.state === "loading"
        ? "Loading text…"
        : snippet.kind === "TEXT" && textContent?.state === "ready" && textContent.migrationError
          ? textContent.migrationError
          : snippet.kind === "TEXT" && textContent?.state === "failed"
            ? textContent.message
            : snippet.kind === "FILE" || snippet.kind === "IMAGE"
              ? fileSubtitle(snippet)
              : isUploadTask(snippet)
                ? ""
                : formatFileSize(snippet.byteSize);
  const time = isUploadTask(snippet)
    ? snippet.phase === "FAILED"
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
              <span className="w-8 text-right text-[11px] tabular-nums text-muted-foreground">
                {uploadProgress === 0 ? "…" : `${uploadProgress}%`}
              </span>
              <Button
                type="button"
                variant="ghost"
                size="icon-sm"
                aria-label="Stop uploading"
                className="text-muted-foreground hover:bg-destructive/10 hover:text-destructive"
                onClick={onStopUpload}
              >
                <X />
              </Button>
            </div>
          ) : (
            <>
              <span className="text-[11px] tabular-nums text-muted-foreground group-hover:hidden group-focus-within:hidden">
                {time}
              </span>

              <div className="hidden items-center gap-0.5 group-hover:flex group-focus-within:flex">
                {snippet.kind === "TEXT" &&
                  (textContent?.state === "failed" ||
                    (textContent?.state === "ready" && textContent.migrationError)) &&
                  onRetryContent && (
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
                  aria-label={copied ? "Copied" : "Copy"}
                  disabled={
                    copyDisabled || (snippet.kind === "TEXT" && textContent?.state !== "ready")
                  }
                  onClick={onCopy}
                >
                  {copied ? <Check className="text-emerald-500" /> : <Copy />}
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
