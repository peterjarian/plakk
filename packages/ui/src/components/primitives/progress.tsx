import type { ComponentProps } from "react";
import { cn } from "@plakk/ui/lib/utils";

function Progress({
  className,
  value,
  ...props
}: ComponentProps<"div"> & {
  value: number;
}) {
  return (
    <div
      data-slot="progress"
      className={cn("h-1.5 overflow-hidden rounded-full bg-muted", className)}
      {...props}
    >
      <div className="h-full rounded-full bg-blue-600" style={{ width: `${value}%` }} />
    </div>
  );
}

export { Progress };
