import { buttonVariants } from "@plakk/ui/primitives/button";
import { ArrowUpRight, CircleCheck } from "lucide-react";
import { useEffect } from "react";

export function DesktopAppHandoff(props: {
  readonly callbackUrl: string;
  readonly title: string;
  readonly description: string;
}) {
  useEffect(() => {
    window.location.assign(props.callbackUrl);
  }, [props.callbackUrl]);

  return (
    <main className="flex min-h-svh items-center justify-center bg-background px-6 py-12 text-foreground">
      <section className="w-full max-w-sm overflow-hidden rounded-xl bg-card text-card-foreground ring-1 ring-foreground/10 shadow-sm">
        <div className="flex items-start gap-4 px-6 py-7">
          <div className="flex size-10 shrink-0 items-center justify-center rounded-full bg-emerald-500/10 text-emerald-600 dark:text-emerald-400">
            <CircleCheck className="size-5" aria-hidden="true" />
          </div>

          <div className="min-w-0 pt-0.5">
            <h1 className="text-lg font-semibold tracking-tight">{props.title}</h1>
            <p className="mt-1 text-sm leading-6 text-muted-foreground">{props.description}</p>
          </div>
        </div>

        <div className="flex items-center justify-between gap-4 border-t border-border bg-muted/30 px-6 py-4">
          <p className="text-xs text-muted-foreground">Didn’t open automatically?</p>
          <a href={props.callbackUrl} className={buttonVariants({ size: "sm" })}>
            Open Plakk
            <ArrowUpRight aria-hidden="true" />
          </a>
        </div>
      </section>
    </main>
  );
}
