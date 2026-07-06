import { FileText, ImageIcon, LinkIcon, Type } from "lucide-react";

const items = [
  {
    Icon: LinkIcon,
    title: "https://plakk.io/pricing",
    detail: "Link - just now",
  },
  {
    Icon: ImageIcon,
    title: "Screenshot 14.32.10.png",
    detail: "Image - 1.8 MB",
  },
  {
    Icon: Type,
    title: "Meeting notes from desktop",
    detail: "Text - 214 chars",
  },
  {
    Icon: FileText,
    title: "Invoice-june.pdf",
    detail: "File - synced",
  },
];

export function TrayQueue() {
  return (
    <section className="min-h-0 flex-1 overflow-hidden px-4 pt-4">
      <div className="mb-1 flex items-center justify-between">
        <h2 className="text-[11px] font-medium tracking-wide text-muted-foreground uppercase">
          Queue
        </h2>
        <span className="text-[11px] tabular-nums text-muted-foreground">4 items</span>
      </div>

      <ul className="-mx-2 overflow-hidden">
        {items.map(({ Icon, title, detail }) => (
          <li key={title} className="flex items-center gap-2.5 rounded-lg px-2 py-2">
            <span className="flex size-8 shrink-0 items-center justify-center rounded-md bg-muted text-muted-foreground">
              <Icon className="size-4" />
            </span>
            <div className="min-w-0 flex-1">
              <p className="truncate text-sm font-medium">{title}</p>
              <p className="truncate text-xs text-muted-foreground">{detail}</p>
            </div>
          </li>
        ))}
      </ul>
    </section>
  );
}
