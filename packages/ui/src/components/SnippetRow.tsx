import { formatFileSize, type SnippetKind } from "@plakk/shared";
import type { ApiSnippet } from "@plakk/shared/PlakkApi";
import {
  ArrowUpRight,
  Check,
  Copy,
  FileText,
  ImageIcon,
  LinkIcon,
  Trash2,
  Type,
  X,
} from "lucide-react";
import type { UploadTask } from "../atoms/upload.ts";
import { Button } from "./primitives/button.tsx";

export type SnippetRowItem = ApiSnippet | UploadTask;

const kindMeta: Record<SnippetKind, { Icon: typeof Type }> = {
  TEXT: { Icon: Type },
  LINK: { Icon: LinkIcon },
  FILE: { Icon: FileText },
  IMAGE: { Icon: ImageIcon },
};

const isUploadTask = (snippet: SnippetRowItem): snippet is UploadTask => "phase" in snippet;

const fileSubtitle = (snippet: Pick<ApiSnippet, "byteSize" | "fileName" | "kind">) =>
  `${snippet.fileName.split(".").pop()?.toUpperCase() ?? snippet.kind} · ${formatFileSize(snippet.byteSize)}`;

export function SnippetRow(props: {
  snippet: SnippetRowItem;
  copied: boolean;
  onCopy: () => void;
  onDelete: () => void;
  onOpenLink?: (url: string) => void;
  onStopUpload: () => void;
}) {
  const { snippet, copied, onCopy, onDelete, onOpenLink, onStopUpload } = props;
  const { Icon } = kindMeta[snippet.kind];
  const uploadProgress = isUploadTask(snippet) ? snippet.progress : undefined;
  const isUploading = isUploadTask(snippet) && snippet.phase !== "FAILED";
  const title = isUploadTask(snippet) ? snippet.fileName : snippet.title;
  const subtitle =
    isUploadTask(snippet) && snippet.phase === "FAILED"
      ? (snippet.errorMessage ?? "Upload failed. Choose the file again to retry.")
      : snippet.kind === "FILE" || snippet.kind === "IMAGE"
        ? fileSubtitle(snippet)
        : isUploadTask(snippet)
          ? ""
          : formatFileSize(snippet.byteSize);
  const time = isUploadTask(snippet)
    ? snippet.phase === "FAILED"
      ? "Failed"
      : ""
    : snippet.createdAt.slice(0, 10);

  return (
    <li>
      <div
        data-snippet-row=""
        tabIndex={0}
        className="group relative flex items-center gap-2.5 rounded-lg px-2 py-2 transition-colors outline-none hover:bg-muted/60 focus-visible:ring-3 focus-visible:ring-ring/50 focus-visible:ring-offset-1 focus-visible:ring-offset-background focus-visible:outline-none focus-within:bg-muted/60"
      >
        <span className="flex size-8 shrink-0 items-center justify-center rounded-md bg-muted text-muted-foreground">
          <Icon className="size-4" />
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
                <Button
                  type="button"
                  variant="ghost"
                  size="icon-sm"
                  aria-label={copied ? "Copied" : "Copy"}
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
      </div>
    </li>
  );
}
