import { Switch as SwitchPrimitive } from "@base-ui/react/switch";

import { cn } from "@plakk/ui/lib/utils";

function Switch({ className, ...props }: SwitchPrimitive.Root.Props) {
  return (
    <SwitchPrimitive.Root
      data-slot="switch"
      className={cn(
        "relative h-5 w-8 rounded-full bg-muted transition-colors outline-none focus-visible:ring-3 focus-visible:ring-ring/50 disabled:cursor-not-allowed disabled:opacity-50 data-checked:bg-blue-600",
        className,
      )}
      {...props}
    >
      <SwitchPrimitive.Thumb
        data-slot="switch-thumb"
        className="absolute top-0.5 left-0.5 size-4 rounded-full bg-background shadow-sm transition-transform data-checked:translate-x-3"
      />
    </SwitchPrimitive.Root>
  );
}

export { Switch };
