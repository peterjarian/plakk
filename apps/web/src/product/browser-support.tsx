import { Button, buttonVariants } from "@plakk/ui/components/primitives/button";
import { RotateCcw } from "lucide-react";
import { useEffect, useState, type ReactNode } from "react";

type BrowserCapabilities = {
  readonly AbortController?: unknown;
  readonly Blob?: unknown;
  readonly File?: unknown;
  readonly ReadableStream?: unknown;
  readonly URL?: unknown;
  readonly crypto?: { readonly randomUUID?: unknown };
  readonly fetch?: unknown;
};

export type RequiredBrowserCapability =
  | "abort-controller"
  | "blob"
  | "fetch"
  | "file"
  | "readable-stream"
  | "secure-random-id"
  | "url";

const requiredCapabilities: ReadonlyArray<
  readonly [RequiredBrowserCapability, (browser: BrowserCapabilities) => boolean]
> = [
  ["abort-controller", (browser) => typeof browser.AbortController === "function"],
  ["blob", (browser) => typeof browser.Blob === "function"],
  ["fetch", (browser) => typeof browser.fetch === "function"],
  ["file", (browser) => typeof browser.File === "function"],
  ["readable-stream", (browser) => typeof browser.ReadableStream === "function"],
  ["secure-random-id", (browser) => typeof browser.crypto?.randomUUID === "function"],
  ["url", (browser) => typeof browser.URL === "function"],
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
            Required Web capabilities for secure account requests and page-scoped Snippet work are
            unavailable. Update this browser or try another current browser.
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

export function BrowserSupportBoundary(props: { readonly children: ReactNode }) {
  const [supported, setSupported] = useState(true);

  useEffect(() => {
    setSupported(missingRequiredBrowserCapabilities(window).length === 0);
  }, []);

  return supported ? props.children : <UnsupportedBrowserView />;
}
