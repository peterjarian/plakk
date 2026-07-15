import { deriveSnippetPresentation, formatFileSize, type SnippetPresentation } from "@plakk/shared";
import type { ApiSnippet } from "@plakk/shared/PlakkApi";
import * as DateTime from "effect/DateTime";
import {
  ArrowUpRight,
  Check,
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

export type SnippetRowItem = ApiSnippet | UploadTask;

export type TextSnippetContent =
  | { readonly state: "loading" }
  | { readonly state: "ready"; readonly text: string }
  | { readonly state: "failed"; readonly message: string };

const presentationMeta: Record<SnippetPresentation["type"], { Icon: typeof Type }> = {
  text: { Icon: Type },
  hyperlink: { Icon: LinkIcon },
  file: { Icon: FileText },
  image: { Icon: ImageIcon },
};

const isUploadTask = (snippet: SnippetRowItem): snippet is UploadTask => "phase" in snippet;

const fileSubtitle = (snippet: Pick<ApiSnippet, "byteSize" | "fileName">) =>
  `${snippet.fileName.split(".").pop()?.toUpperCase() ?? "FILE"} · ${formatFileSize(snippet.byteSize)}`;

const presentationFor = (
  snippet: SnippetRowItem,
  textContent: TextSnippetContent | undefined,
): SnippetPresentation => {
  const content = textContent?.state === "ready" ? textContent.text : undefined;
  if (!isUploadTask(snippet) || snippet.presentationType === "text") {
    return deriveSnippetPresentation(
      content === undefined
        ? { fileName: snippet.fileName }
        : { fileName: snippet.fileName, content },
    );
  }
  return {
    type: snippet.presentationType,
    title: snippet.fileName,
  };
};

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
    onStopUpload,
    textContent,
    thumbnailUrl,
    copyDisabled = false,
    copying = false,
    copyError,
    showActions = true,
  } = props;
  const presentation = presentationFor(snippet, textContent);
  const { Icon } = presentationMeta[presentation.type];
  const isUploading = isUploadTask(snippet) && snippet.phase !== "FAILED";
  const title = presentation.title;
  const isText = presentation.type === "text" || presentation.type === "hyperlink";
  const subtitle =
    isUploadTask(snippet) && snippet.phase === "FAILED"
      ? (snippet.errorMessage ?? "Upload failed. Choose the file again to retry.")
      : isText && textContent?.state === "loading"
        ? "Loading text…"
        : isText && textContent?.state === "failed"
          ? textContent.message
          : presentation.type === "file" || presentation.type === "image"
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
          {isUploading ? (
            <div className="flex items-center gap-1">
              <LoaderCircle
                className="size-4 animate-spin text-muted-foreground"
                aria-hidden="true"
              />
              {showActions && (
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
                {isText && textContent?.state === "failed" && onRetryContent && (
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
                  disabled={copying || copyDisabled || (isText && textContent?.state !== "ready")}
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
                {presentation.type === "hyperlink" && (
                  <>
                    {onOpenLink ? (
                      <Button
                        type="button"
                        variant="ghost"
                        size="icon-sm"
                        aria-label="Open link"
                        onClick={() => onOpenLink(presentation.url)}
                      >
                        <ArrowUpRight />
                      </Button>
                    ) : (
                      <Button
                        render={<a href={presentation.url} target="_blank" rel="noreferrer" />}
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
