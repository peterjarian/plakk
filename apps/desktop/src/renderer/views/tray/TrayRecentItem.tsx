import { useEffect, useState } from "react";
import { SnippetRow, type SnippetRowItem } from "@plakk/ui/components/SnippetRow";
import { decodeTextSnippet } from "../../lib/textSnippetContent.ts";

const noop = () => undefined;

export function TrayRecentItem({ snippet }: { snippet: SnippetRowItem | undefined }) {
  const [textContent, setTextContent] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    setTextContent(null);
    if (
      snippet?.kind === "TEXT" &&
      ("phase" in snippet ? "createdAt" in snippet : snippet.uploadStatus === "READY")
    ) {
      void window.ipc.snippets
        .read(snippet.id)
        .then((bytes) => {
          if (active) setTextContent(decodeTextSnippet(bytes));
        })
        .catch(() => undefined);
    }
    return () => {
      active = false;
    };
  }, [snippet]);

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
          showActions={false}
          {...(snippet.kind === "TEXT" && textContent !== null
            ? { textContent: { state: "ready" as const, text: textContent } }
            : snippet.kind === "TEXT" && !("phase" in snippet) && snippet.textContent !== null
              ? { textContent: { state: "ready" as const, text: snippet.textContent } }
              : {})}
        />
      </ul>
    </section>
  );
}
