import { Cloud, FileUp } from "lucide-react";

export function TrayDropZone() {
  return (
    <section className="px-4 pt-4">
      <div className="grid h-28 place-items-center rounded-lg border border-dashed bg-card text-center">
        <div className="grid justify-items-center gap-2">
          <span className="flex size-9 items-center justify-center rounded-md bg-muted text-muted-foreground">
            <FileUp className="size-4" />
          </span>
          <div className="grid gap-0.5">
            <p className="text-sm font-medium">Drop anything here</p>
            <p className="flex items-center justify-center gap-1 text-xs text-muted-foreground">
              <Cloud className="size-3" />
              Ready to sync
            </p>
          </div>
        </div>
      </div>
    </section>
  );
}
