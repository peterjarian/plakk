import { ArrowRight } from "lucide-react";
import { Button } from "@plakk/ui/components/primitives/button";
import { useAuth } from "../hooks/useAuth.ts";
import { TrayActions } from "./tray/TrayActions.tsx";
import { TrayDropZone } from "./tray/TrayDropZone.tsx";
import { TrayQueue } from "./tray/TrayQueue.tsx";
import { TrayShell } from "./tray/TrayShell.tsx";

export function Tray() {
  const auth = useAuth();

  if (auth.user === null) {
    return (
      <TrayShell>
        <section className="drag-region flex min-h-0 flex-1 flex-col justify-center gap-4 p-4 text-center">
          <div className="grid gap-1">
            <p className="text-xs font-medium tracking-wide text-muted-foreground uppercase">
              Plakk
            </p>
            <h1 className="text-xl leading-tight font-semibold">Sign in to use the tray.</h1>
            <p className="text-sm text-muted-foreground">
              Drop, capture, and send snippets from here once connected.
            </p>
          </div>

          {auth.issue && <p className="text-xs text-muted-foreground">{auth.issue.message}</p>}

          <Button
            type="button"
            className="h-9 w-full"
            disabled={auth.isLoading}
            onClick={() => void auth.signIn()}
          >
            {auth.isLoading ? "Checking session..." : "Sign in"}
            <ArrowRight />
          </Button>
        </section>
      </TrayShell>
    );
  }

  return (
    <TrayShell>
      <TrayDropZone />
      <TrayQueue />
      <TrayActions />
    </TrayShell>
  );
}
