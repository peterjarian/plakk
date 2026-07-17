import { SnippetRow } from "@plakk/ui/components/SnippetRow";
import { Button } from "@plakk/ui/components/primitives/button";

import type { SnippetReadModel } from "../../hooks/useSnippets.ts";

export function TrayRecentItem({
  snippet,
  copied,
  copying,
  copyDisabled,
  copyError,
  readError,
  onReload,
  onCopy,
  onDelete,
  onDownload,
  onOpenLink,
  onRetryUpload,
  onStopUpload,
}: {
  snippet: SnippetReadModel | undefined;
  copied: boolean;
  copying: boolean;
  copyDisabled: boolean;
  copyError?: string;
  readError: string | null;
  onReload: () => void;
  onCopy: () => void;
  onDelete: () => void;
  onDownload: () => void;
  onOpenLink: (url: string) => void;
  onRetryUpload: () => void;
  onStopUpload: () => void;
}) {
  if (!snippet) {
    if (readError !== null) {
      return (
        <section className="grid min-h-0 flex-1 place-content-center gap-2 px-6 text-center">
          <p className="text-xs text-destructive" role="alert">
            {readError}
          </p>
          <Button type="button" variant="outline" size="sm" onClick={onReload}>
            Try again
          </Button>
        </section>
      );
    }
    return (
      <section className="grid min-h-0 flex-1 place-content-center gap-1 px-6 text-center">
        <p className="text-sm font-medium">Nothing added yet</p>
        <p className="text-xs text-muted-foreground">Drag something anywhere onto the tray</p>
      </section>
    );
  }

  return (
    <section className="px-4 pt-4 pb-3">
      <h2 className="mb-2 text-[11px] font-medium tracking-wide text-muted-foreground uppercase">
        Last added
      </h2>
      <ul className="rounded-lg border bg-card px-1 py-1">
        <SnippetRow
          snippet={snippet}
          presentation={snippet.presentation}
          now={Date.now()}
          copied={copied}
          copying={copying}
          copyDisabled={copyDisabled}
          thumbnailUrl={snippet.thumbnailUrl}
          {...(copyError === undefined ? {} : { copyError })}
          onCopy={onCopy}
          onDelete={onDelete}
          onDownload={onDownload}
          onOpenLink={onOpenLink}
          onRetryUpload={onRetryUpload}
          onStopUpload={onStopUpload}
        />
      </ul>
    </section>
  );
}
