import { FileText, ImageIcon, LinkIcon, Type } from "lucide-react";
import type { Snippet } from "../../lib/snippets.ts";

const icons = {
  FILE: FileText,
  IMAGE: ImageIcon,
  LINK: LinkIcon,
  TEXT: Type,
};

export function TrayQueue({ snippets, totalCount }: { snippets: Snippet[]; totalCount: number }) {
  return (
    <section className="min-h-0 flex-1 overflow-hidden px-4 pt-4">
      <div className="mb-1 flex items-center justify-between">
        <h2 className="text-[11px] font-medium tracking-wide text-muted-foreground uppercase">
          Queue
        </h2>
        <span className="text-[11px] tabular-nums text-muted-foreground">{totalCount} items</span>
      </div>

      <ul className="-mx-2 overflow-hidden">
        {snippets.map((snippet) => {
          const Icon = icons[snippet.kind];
          const detail =
            snippet.uploadProgress === undefined
              ? snippet.subtitle || (snippet.synced ? "Synced" : "Waiting to sync")
              : `Uploading ${snippet.uploadProgress}%`;

          return (
            <li key={snippet.id} className="flex items-center gap-2.5 rounded-lg px-2 py-2">
              <span className="flex size-8 shrink-0 items-center justify-center rounded-md bg-muted text-muted-foreground">
                <Icon className="size-4" />
              </span>
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm font-medium">{snippet.title}</p>
                <p className="truncate text-xs text-muted-foreground">{detail}</p>
              </div>
            </li>
          );
        })}
      </ul>
    </section>
  );
}
