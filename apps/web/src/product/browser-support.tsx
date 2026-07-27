import { Button, buttonVariants } from "@plakk/ui/components/primitives/button";
import { RotateCcw } from "lucide-react";
import type { ReactNode } from "react";

type BrowserCapabilities = {
  readonly ReadableStream?: unknown;
  readonly fetch?: unknown;
};

export type RequiredBrowserCapability = "fetch" | "readable-stream";

const requiredCapabilities: ReadonlyArray<
  readonly [RequiredBrowserCapability, (browser: BrowserCapabilities) => boolean]
> = [
  ["fetch", (browser) => typeof browser.fetch === "function"],
  ["readable-stream", (browser) => typeof browser.ReadableStream === "function"],
];

export const missingRequiredBrowserCapabilities = (
  browser: BrowserCapabilities = globalThis,
): ReadonlyArray<RequiredBrowserCapability> =>
  requiredCapabilities.flatMap(([capability, supported]) =>
    supported(browser) ? [] : [capability],
  );

export function UnsupportedBrowserView(props: { readonly onRetry?: () => void }) {
  const onRetry =
    props.onRetry ??
    (() => {
      window.location.reload();
    });

  return (
    <main className="grid min-h-dvh place-items-center bg-background px-4 py-8 text-foreground sm:px-6">
      <section
        className="grid w-full max-w-lg gap-5 rounded-xl border border-border bg-card p-5 text-center sm:p-6"
        role="alert"
      >
        <div className="grid gap-2">
          <p className="text-xs font-medium tracking-wide text-muted-foreground uppercase">Plakk</p>
          <h1 className="text-2xl font-semibold tracking-tight">This browser can’t run Plakk</h1>
          <p className="text-sm text-muted-foreground">
            Required Web capabilities for streaming secure account requests are unavailable. Update
            this browser or try another current browser.
          </p>
        </div>
        <div className="grid gap-2 sm:grid-cols-2">
          <Button type="button" onClick={onRetry}>
            <RotateCcw aria-hidden="true" />
            Check again
          </Button>
          <a className={buttonVariants({ variant: "outline" })} href="mailto:help@plakk.io">
            Contact help
          </a>
        </div>
      </section>
    </main>
  );
}

export function BrowserSupportBoundary(props: {
  readonly capabilities?: BrowserCapabilities | null;
  readonly children: ReactNode;
}) {
  const capabilities =
    props.capabilities === undefined
      ? typeof window === "undefined"
        ? null
        : window
      : props.capabilities;
  return capabilities === null || missingRequiredBrowserCapabilities(capabilities).length === 0 ? (
    props.children
  ) : (
    <UnsupportedBrowserView />
  );
}
