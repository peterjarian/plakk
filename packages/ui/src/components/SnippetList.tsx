import type { ComponentProps, KeyboardEvent } from "react";
import { Paperclip } from "lucide-react";

import { cn } from "../lib/utils.ts";
import {
  Empty as EmptyPrimitive,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "../primitives/empty.tsx";

export type SnippetListProps = ComponentProps<"section">;

function Root({ className, ...props }: SnippetListProps) {
  return (
    <section
      data-slot="snippet-list"
      className={cn("flex min-h-0 flex-1 flex-col", className)}
      {...props}
    />
  );
}

export type SnippetListHeadingProps = Omit<ComponentProps<"h2">, "children">;

function Heading({ className, ...props }: SnippetListHeadingProps) {
  return (
    <h2
      data-slot="snippet-list-heading"
      className={cn(
        "mb-1 text-[11px] font-medium tracking-wide text-muted-foreground uppercase",
        className,
      )}
      {...props}
    >
      Recent
    </h2>
  );
}

export type SnippetListItemsProps = ComponentProps<"ul">;

function Items({ className, onKeyDown, ...props }: SnippetListItemsProps) {
  function focusRow(event: KeyboardEvent<HTMLUListElement>) {
    onKeyDown?.(event);
    if (event.defaultPrevented || (event.key !== "ArrowDown" && event.key !== "ArrowUp")) {
      return;
    }

    const rows = Array.from(
      event.currentTarget.querySelectorAll<HTMLElement>("[data-snippet-row]"),
    );
    const currentIndex = rows.indexOf(document.activeElement as HTMLElement);
    if (currentIndex === -1) return;

    const offset = event.key === "ArrowUp" ? -1 : 1;
    rows.at((currentIndex + offset + rows.length) % rows.length)?.focus();
    event.preventDefault();
  }

  return (
    <ul
      data-slot="snippet-list-items"
      className={cn("-mx-2 flex flex-col", className)}
      onKeyDown={focusRow}
      {...props}
    />
  );
}

function Empty() {
  return (
    <EmptyPrimitive data-slot="snippet-list-empty" className="border border-border">
      <EmptyHeader>
        <EmptyMedia variant="icon">
          <Paperclip />
        </EmptyMedia>
        <EmptyTitle>Nothing added yet</EmptyTitle>
        <EmptyDescription>
          Add something above and it shows up on your other devices.
        </EmptyDescription>
      </EmptyHeader>
    </EmptyPrimitive>
  );
}

export const SnippetList = {
  Root,
  Heading,
  Items,
  Empty,
};
