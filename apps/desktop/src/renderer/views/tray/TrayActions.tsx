import { Clipboard, MonitorUp, Plus } from "lucide-react";
import { Button } from "@plakk/ui/components/primitives/button";

export function TrayActions() {
  return (
    <footer className="grid shrink-0 grid-cols-3 gap-2 border-t p-4">
      <Button type="button" variant="outline" size="sm" disabled>
        <Clipboard />
        Paste
      </Button>
      <Button type="button" variant="outline" size="sm" disabled>
        <MonitorUp />
        Capture
      </Button>
      <Button type="button" size="sm" disabled>
        <Plus />
        Add
      </Button>
    </footer>
  );
}
