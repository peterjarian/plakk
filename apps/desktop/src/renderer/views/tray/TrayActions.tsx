import { Check, ClipboardPaste, Copy, FileUp, LoaderCircle } from "lucide-react";
import { Button } from "@plakk/ui/components/primitives/button";

export function TrayActions({
  copyDisabled,
  copied,
  copying,
  ingestionDisabled,
  onCopy,
  onPaste,
  onSelect,
}: {
  copyDisabled: boolean;
  copied: boolean;
  copying: boolean;
  ingestionDisabled: boolean;
  onCopy: () => void;
  onPaste: () => void;
  onSelect: () => void;
}) {
  return (
    <footer className="grid shrink-0 grid-cols-3 gap-2 px-4 pb-4">
      <Button
        type="button"
        variant="outline"
        size="sm"
        disabled={copyDisabled || copying}
        onClick={onCopy}
      >
        {copying ? <LoaderCircle className="animate-spin" /> : copied ? <Check /> : <Copy />}
        Copy
      </Button>
      <Button
        type="button"
        variant="outline"
        size="sm"
        disabled={ingestionDisabled}
        onClick={onPaste}
      >
        <ClipboardPaste />
        Paste
      </Button>
      <Button
        type="button"
        variant="outline"
        size="sm"
        disabled={ingestionDisabled}
        onClick={onSelect}
      >
        <FileUp />
        Select
      </Button>
    </footer>
  );
}
