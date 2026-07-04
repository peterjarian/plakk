import type { KeyboardEvent, ReactNode } from "react";
import { Paperclip } from "lucide-react";
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "./primitives/empty";

export function SnippetList(props: { empty: boolean; children: ReactNode }) {
  const { empty, children } = props;

  function focusRow(event: KeyboardEvent<HTMLUListElement>) {
    if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;

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
    <section className="flex min-h-0 flex-1 flex-col">
      <div className="mb-1 flex items-center justify-between">
        <span className="text-[11px] font-medium tracking-wide text-muted-foreground uppercase">
          Recent
        </span>
      </div>

      {empty ? (
        <Empty className="border border-border">
          <EmptyHeader>
            <EmptyMedia variant="icon">
              <Paperclip />
            </EmptyMedia>
            <EmptyTitle>Nothing added yet</EmptyTitle>
            <EmptyDescription>
              Add something above and it shows up on your other devices.
            </EmptyDescription>
          </EmptyHeader>
        </Empty>
      ) : (
        <ul className="-mx-2 flex flex-col" onKeyDown={focusRow}>
          {children}
        </ul>
      )}
    </section>
  );
}
