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
      <section className="flex w-full max-w-md flex-col items-center text-center">
        <div className="mb-6 flex size-12 items-center justify-center rounded-full bg-emerald-500/10 text-emerald-600 dark:text-emerald-400">
          <CircleCheck className="size-6" aria-hidden="true" />
        </div>

        <h1 className="text-2xl font-semibold tracking-tight">You’re all set</h1>
        <p className="mt-2 max-w-sm text-sm leading-6 text-muted-foreground">
          Plakk is opening. You can close this window and continue in the desktop app.
        </p>

        <a href={callbackUrl} className={buttonVariants({ className: "mt-7", size: "lg" })}>
          Open Plakk
          <ArrowUpRight aria-hidden="true" />
        </a>

        <p className="mt-3 text-xs text-muted-foreground">
          If Plakk didn’t open automatically, use the button above.
        </p>
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
