import {
  cloneElement,
  createContext,
  useContext,
  useMemo,
  useState,
  type ComponentProps,
  type ReactElement,
} from "react";
import { Paperclip } from "lucide-react";

import { cn } from "@plakk/ui/lib/utils";
import { Button } from "@plakk/ui/primitives/button";

type ComposerContextValue = {
  disabled: boolean;
  value: string;
  setValue: (value: string) => void;
};

const ComposerContext = createContext<ComposerContextValue | null>(null);

function useComposer(part: string) {
  const context = useContext(ComposerContext);
  if (context === null) {
    throw new Error(`SnippetComposer.${part} must be used inside SnippetComposer.Root`);
  }
  return context;
}

export type SnippetComposerRootProps = Omit<ComponentProps<"form">, "onSubmit"> & {
  disabled?: boolean;
  onSubmit: (value: string) => void;
};

function Root({
  children,
  className,
  disabled = false,
  onSubmit,
  ...props
}: SnippetComposerRootProps) {
  const [value, setValue] = useState("");
  const context = useMemo(() => ({ disabled, value, setValue }), [disabled, value]);

  return (
    <ComposerContext.Provider value={context}>
      <form
        {...props}
        data-slot="snippet-composer"
        className={cn(
          "flex items-center gap-1 rounded-lg border border-border bg-card p-1 transition-colors",
          disabled && "opacity-60",
          className,
        )}
        onSubmit={(event) => {
          event.preventDefault();
          const trimmed = value.trim();
          if (disabled || !trimmed) return;
          onSubmit(trimmed);
          setValue("");
        }}
      >
        {children}
      </form>
    </ComposerContext.Provider>
  );
}

export type SnippetComposerInputProps = Omit<
  ComponentProps<"input">,
  | "children"
  | "className"
  | "defaultValue"
  | "disabled"
  | "onChange"
  | "placeholder"
  | "type"
  | "value"
>;

function Input(props: SnippetComposerInputProps) {
  const { disabled, setValue, value } = useComposer("Input");

  return (
    <label className="min-w-0 flex-1">
      <span className="sr-only">Text or link to add</span>
      <input
        {...props}
        data-slot="snippet-composer-input"
        className="h-7 w-full bg-transparent px-1 text-sm leading-none placeholder:text-muted-foreground focus:outline-none"
        type="text"
        placeholder="Paste or write whatever you want"
        value={value}
        disabled={disabled}
        onChange={(event) => setValue(event.target.value)}
      />
    </label>
  );
}

type NativeFileControlProps = ComponentProps<"input">;

export type SnippetComposerAttachmentProps =
  | {
      children: ReactElement<NativeFileControlProps>;
      onSelect?: never;
    }
  | {
      children?: never;
      onSelect: () => void;
    };

function Attachment(props: SnippetComposerAttachmentProps) {
  const { disabled } = useComposer("Attachment");

  if ("onSelect" in props) {
    return (
      <Button
        type="button"
        variant="ghost"
        size="icon-sm"
        toolTip="Attach files"
        aria-label="Choose file"
        disabled={disabled}
        onClick={props.onSelect}
      >
        <Paperclip aria-hidden="true" />
      </Button>
    );
  }

  const control = cloneElement(props.children, {
    ...props.children.props,
    className: "sr-only",
    disabled,
    type: "file",
  });

  return (
    <Button
      render={<label />}
      variant="ghost"
      size="icon-sm"
      className={cn("cursor-pointer", disabled && "cursor-default")}
      toolTip="Attach files"
      aria-disabled={disabled}
    >
      <Paperclip aria-hidden="true" />
      <span className="sr-only">Choose file</span>
      {control}
    </Button>
  );
}

export type SnippetComposerSubmitProps = Omit<
  ComponentProps<typeof Button>,
  "children" | "className" | "disabled" | "size" | "toolTip" | "type" | "variant"
>;

function Submit(props: SnippetComposerSubmitProps) {
  const { disabled, value } = useComposer("Submit");

  return (
    <Button
      {...props}
      type="submit"
      size="sm"
      disabled={disabled || !value.trim()}
      className="disabled:border-border disabled:bg-muted disabled:text-muted-foreground disabled:opacity-100"
      toolTip="Add this text or link"
    >
      Add
    </Button>
  );
}

export const SnippetComposer = {
  Root,
  Input,
  Attachment,
  Submit,
};
