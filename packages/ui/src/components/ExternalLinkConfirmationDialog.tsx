import { ArrowUpRight, TriangleAlert } from "lucide-react";
import type { ReactNode } from "react";

import { Button } from "./primitives/button.tsx";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "./primitives/dialog.tsx";

const externalLinkHost = (url: string) => {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
};

export function ExternalLinkConfirmationDialog(props: {
  readonly description: string;
  readonly onCancel: () => void;
  readonly onConfirm: () => void;
  readonly open: boolean;
  readonly preference?: ReactNode;
  readonly url: string | null;
}) {
  const { description, onCancel, onConfirm, open, preference, url } = props;

  return (
    <Dialog
      open={open}
      onOpenChange={(nextOpen) => {
        if (!nextOpen) onCancel();
      }}
    >
      <DialogContent className="w-[min(calc(100%-2rem),24rem)]">
        <DialogHeader>
          <div className="flex items-start gap-3">
            <div className="mt-0.5 flex size-8 shrink-0 items-center justify-center rounded-lg bg-amber-100 text-amber-700 dark:bg-amber-400/15 dark:text-amber-300">
              <TriangleAlert className="size-4" aria-hidden="true" />
            </div>
            <div className="grid gap-2">
              <DialogTitle>Open external link?</DialogTitle>
              <DialogDescription>{description}</DialogDescription>
            </div>
          </div>
        </DialogHeader>

        {url !== null && (
          <div className="grid gap-3">
            <div className="rounded-lg border border-amber-300/70 bg-amber-50/70 px-3 py-2 text-sm dark:border-amber-400/25 dark:bg-amber-400/10">
              <p className="truncate font-medium">{externalLinkHost(url)}</p>
              <p className="truncate text-xs text-muted-foreground">{url}</p>
            </div>
            {preference}
          </div>
        )}

        <DialogFooter className="flex-row justify-end">
          <Button type="button" variant="outline" onClick={onCancel}>
            Cancel
          </Button>
          <Button type="button" onClick={onConfirm}>
            Open link
            <ArrowUpRight />
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
