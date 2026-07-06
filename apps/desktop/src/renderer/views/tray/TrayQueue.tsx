import { FileText, ImageIcon, LinkIcon, Type } from "lucide-react";

export type TrayQueueItem = {
  detail: string;
  kind: "file" | "image" | "link" | "text";
  title: string;
};

const icons = {
  file: FileText,
  image: ImageIcon,
  link: LinkIcon,
  text: Type,
};

export function TrayQueue({ items }: { items: TrayQueueItem[] }) {
  return (
    <section className="min-h-0 flex-1 overflow-hidden px-4 pt-4">
      <div className="mb-1 flex items-center justify-between">
        <h2 className="text-[11px] font-medium tracking-wide text-muted-foreground uppercase">
          Queue
        </h2>
        <span className="text-[11px] tabular-nums text-muted-foreground">{items.length} items</span>
      </div>

      <ul className="-mx-2 overflow-hidden">
        {items.map(({ detail, kind, title }) => {
          const Icon = icons[kind];

          return (
            <li key={`${kind}:${title}`} className="flex items-center gap-2.5 rounded-lg px-2 py-2">
              <span className="flex size-8 shrink-0 items-center justify-center rounded-md bg-muted text-muted-foreground">
                <Icon className="size-4" />
              </span>
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm font-medium">{title}</p>
                <p className="truncate text-xs text-muted-foreground">{detail}</p>
              </div>
            </li>
          );
        })}
      </ul>
    </section>
  );
}
