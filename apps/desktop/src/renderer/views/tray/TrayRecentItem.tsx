import type { DesktopSnippet } from "../../../ipc/contracts.ts";
import { SnippetRow } from "@plakk/ui/components/SnippetRow";

const noop = () => undefined;

export function TrayRecentItem({ snippet }: { snippet: DesktopSnippet | undefined }) {
  if (!snippet) {
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
          now={Date.now()}
          copied={false}
          onCopy={noop}
          onDelete={noop}
          onStopUpload={noop}
          {...(snippet.localTextContent === null
            ? {}
            : { textContent: { state: "ready" as const, text: snippet.localTextContent } })}
          showActions={false}
        />
      </ul>
    </section>
  );
}
