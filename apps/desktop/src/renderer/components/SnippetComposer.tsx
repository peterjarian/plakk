import { useState } from "react";
import { Paperclip } from "lucide-react";
import { Button } from "@plakk/ui/components/primitives/button";
import { cn } from "@plakk/ui/lib/utils";

export function SnippetComposer(props: {
  className?: string;
  disabled?: boolean;
  fileDisabled?: boolean;
  onSubmit: (value: string) => boolean | Promise<boolean>;
  onFiles: (files: FileList) => void;
}) {
  const { className, disabled = false, fileDisabled = disabled, onSubmit, onFiles } = props;
  const [value, setValue] = useState("");
  const trimmed = value.trim();

  return (
    <form
      className={cn(
        "flex items-center gap-1 rounded-lg border border-border bg-card p-1 transition-colors",
        disabled && "opacity-60",
        className,
      )}
      onSubmit={async (event) => {
        event.preventDefault();
        if (disabled || !trimmed) return;
        if (await onSubmit(trimmed)) setValue("");
      }}
    >
      <label className="min-w-0 flex-1">
        <span className="sr-only">Text or link to add</span>
        <input
          className="h-7 w-full bg-transparent px-1 text-sm leading-none placeholder:text-muted-foreground focus:outline-none"
          type="text"
          placeholder="Paste or write whatever you want"
          value={value}
          disabled={disabled}
          onChange={(event) => setValue(event.target.value)}
        />
      </label>

      <Button
        render={<label />}
        variant="ghost"
        size="icon-sm"
        className={cn("cursor-pointer", fileDisabled && "cursor-default")}
        toolTip="Attach files"
        aria-disabled={fileDisabled}
      >
        <Paperclip className="size-4" aria-hidden="true" />
        <span className="sr-only">Choose file</span>
        <input
          className="sr-only"
          type="file"
          multiple
          disabled={fileDisabled}
          onChange={(event) => {
            if (event.currentTarget.files?.length) onFiles(event.currentTarget.files);
            event.currentTarget.value = "";
          }}
        />
      </Button>
      <Button
        type="submit"
        size="sm"
        disabled={disabled || !trimmed}
        className="disabled:border-border disabled:bg-muted disabled:text-muted-foreground disabled:opacity-100"
        toolTip="Add this text or link"
      >
        Add
      </Button>
    </form>
  );
}
