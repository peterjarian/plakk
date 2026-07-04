import { Check, Cloud, Image as ImageIcon, Laptop, Link, Smartphone, Type } from "lucide-react";

import "./styles.css";

const snippets = [
  { label: "Link", Icon: Link, delay: "", top: "top-34" },
  { label: "Image", Icon: ImageIcon, delay: "plakk-flow-animation__delay-1", top: "top-41" },
  { label: "Note", Icon: Type, delay: "plakk-flow-animation__delay-2", top: "top-48" },
];

export function SnippetFlowAnimation() {
  return (
    <div className="relative h-80 overflow-hidden rounded-2xl border bg-card">
      <div className="absolute top-5 left-5 flex items-center gap-2 text-sm font-medium">
        <Laptop className="size-4 text-muted-foreground" aria-hidden="true" />
        Mac
      </div>
      <div className="absolute top-5 right-5 flex items-center gap-2 text-sm font-medium">
        Phone
        <Smartphone className="size-4 text-muted-foreground" aria-hidden="true" />
      </div>

      <div className="absolute top-18 left-6 w-28 rounded-xl border bg-background p-2 shadow-sm">
        <div className="mb-2 h-2 w-12 rounded-full bg-muted" />
        <div className="grid gap-1.5">
          <div className="h-7 rounded-md bg-muted px-2 py-1 text-xs font-medium">paste</div>
          <div className="h-7 rounded-md bg-muted px-2 py-1 text-xs font-medium">drop</div>
          <div className="h-7 rounded-md bg-muted px-2 py-1 text-xs font-medium">type</div>
        </div>
      </div>

      <div className="absolute top-37 right-34 left-34 h-px bg-border" aria-hidden="true" />

      <div className="absolute top-30 left-1/2 -translate-x-1/2">
        <div className="plakk-flow-animation__cloud flex size-14 items-center justify-center rounded-full border bg-background shadow-sm">
          <Cloud className="size-5" aria-hidden="true" />
        </div>
      </div>

      <div className="absolute top-18 right-6 w-28 rounded-[1.25rem] border bg-background p-2 shadow-sm">
        <div className="mx-auto mb-2 h-1 w-8 rounded-full bg-muted" />
        <div className="grid gap-1.5">
          {snippets.map(({ label, Icon, delay }) => (
            <div
              key={label}
              className={`plakk-flow-animation__received ${delay} flex h-7 items-center gap-1.5 rounded-md bg-muted px-2 text-xs font-medium opacity-0`}
            >
              <Icon className="size-3.5 text-muted-foreground" aria-hidden="true" />
              {label}
              <Check className="ml-auto size-3 text-emerald-600" aria-hidden="true" />
            </div>
          ))}
        </div>
      </div>

      {snippets.map(({ label, Icon, delay, top }) => (
        <div
          key={label}
          className={`plakk-flow-animation__moving ${delay} absolute left-24 flex h-8 items-center gap-1.5 rounded-lg border bg-background px-2 text-xs font-medium shadow-sm ${top}`}
        >
          <Icon className="size-3.5" aria-hidden="true" />
          {label}
        </div>
      ))}

      <p className="absolute right-5 bottom-5 left-5 text-center text-sm font-medium text-muted-foreground">
        Available on your other devices.
      </p>
    </div>
  );
}
