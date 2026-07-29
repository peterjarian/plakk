import { Button } from "@plakk/ui/components/primitives/button";
import { ArrowUpRight } from "lucide-react";

export function Welcome(props: {
  readonly error: string | null;
  readonly loading: boolean;
  readonly onSignIn: () => void;
}) {
  return (
    <main className="grid min-h-screen place-items-center bg-background p-6 text-foreground">
      <section className="grid w-full max-w-md gap-5 text-center">
        <div className="grid gap-1">
          <p className="text-xs font-medium tracking-wide text-muted-foreground uppercase">Plakk</p>
          <h1 className="text-2xl leading-tight font-semibold">Move snippets between devices.</h1>
        </div>
        {props.error && <p className="text-xs text-destructive">{props.error}</p>}
        <Button
          type="button"
          className="h-10 w-full"
          disabled={props.loading}
          onClick={props.onSignIn}
        >
          {props.loading ? "Checking session…" : "Sign in"}
          <ArrowUpRight />
        </Button>
      </section>
    </main>
  );
}
