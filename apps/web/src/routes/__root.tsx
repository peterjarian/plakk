import type { ReactNode } from "react";
import { HeadContent, Outlet, Scripts, createRootRoute } from "@tanstack/react-router";
import { AuthKitProvider } from "@workos/authkit-tanstack-react-start/client";
import { getAuth } from "@workos/authkit-tanstack-react-start";
import { TooltipProvider } from "@plakk/ui/components/primitives/tooltip";

import { WebProductProvider } from "../product/WebProductProvider.tsx";
import { WebStorageOnboardingProvider } from "../product/WebStorageOnboardingProvider.tsx";
import appCss from "../styles.css?url";

export const Route = createRootRoute({
  beforeLoad: async () => ({ auth: await getAuth() }),
  head: () => ({
    meta: [
      {
        charSet: "utf-8",
      },
      {
        name: "viewport",
        content: "width=device-width, initial-scale=1",
      },
      {
        title: "Plakk",
      },
    ],
    links: [
      {
        rel: "stylesheet",
        href: appCss,
      },
    ],
  }),
  component: RootComponent,
});

function RootComponent() {
  const { auth: initialAuth } = Route.useRouteContext();
  return (
    <RootDocument>
      <AuthKitProvider initialAuth={initialAuth}>
        <TooltipProvider>
          <WebStorageOnboardingProvider>
            <WebProductProvider>
              <Outlet />
            </WebProductProvider>
          </WebStorageOnboardingProvider>
        </TooltipProvider>
      </AuthKitProvider>
    </RootDocument>
  );
}

function RootDocument({ children }: Readonly<{ children: ReactNode }>) {
  return (
    <html lang="en">
      <head>
        <HeadContent />
      </head>
      <body>
        {children}
        <Scripts />
      </body>
    </html>
  );
}
