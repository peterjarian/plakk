import { buttonVariants } from "@plakk/ui/primitives/button";
import { createFileRoute, useLocation } from "@tanstack/react-router";
import { ArrowUpRight, CircleCheck } from "lucide-react";
import { useEffect } from "react";

export function desktopAuthDeepLink(search: string, isDevelopment: boolean): string {
  const query = search.length === 0 || search.startsWith("?") ? search : `?${search}`;
  const protocol = isDevelopment ? "plakk-dev" : "plakk";
  return `${protocol}://auth/callback${query}`;
}

function DesktopAuthCallback() {
  const search = useLocation({ select: (location) => location.searchStr });
  const callbackUrl = desktopAuthDeepLink(search, import.meta.env.DEV);

  useEffect(() => {
    window.location.assign(callbackUrl);
  }, [callbackUrl]);

  return (
    <main className="flex min-h-svh items-center justify-center bg-background px-6 py-12 text-foreground">
      <section className="w-full max-w-sm overflow-hidden rounded-xl bg-card text-card-foreground ring-1 ring-foreground/10 shadow-sm">
        <div className="flex items-start gap-4 px-6 py-7">
          <div className="flex size-10 shrink-0 items-center justify-center rounded-full bg-emerald-500/10 text-emerald-600 dark:text-emerald-400">
            <CircleCheck className="size-5" aria-hidden="true" />
          </div>

          <div className="min-w-0 pt-0.5">
            <h1 className="text-lg font-semibold tracking-tight">You’re all set</h1>
            <p className="mt-1 text-sm leading-6 text-muted-foreground">
              Plakk is opening. You can close this window and continue in the desktop app.
            </p>
          </div>
        </div>

        <div className="flex items-center justify-between gap-4 border-t border-border bg-muted/30 px-6 py-4">
          <p className="text-xs text-muted-foreground">Didn’t open automatically?</p>
          <a href={callbackUrl} className={buttonVariants({ size: "sm" })}>
            Open Plakk
            <ArrowUpRight aria-hidden="true" />
          </a>
        </div>
      </section>
    </main>
  );
}

export const Route = createFileRoute("/auth/desktop/callback")({
  head: () => ({
    meta: [{ title: "Sign-in complete · Plakk" }],
  }),
  component: DesktopAuthCallback,
});
