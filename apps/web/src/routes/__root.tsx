import type { ReactNode } from "react";
import { HeadContent, Outlet, Scripts, createRootRoute } from "@tanstack/react-router";
import { getAuth } from "@workos/authkit-tanstack-react-start";
import { AuthKitProvider } from "@workos/authkit-tanstack-react-start/client";
import { TooltipProvider } from "@plakk/ui/components/primitives/tooltip";

import appCss from "../styles.css?url";

export const Route = createRootRoute({
  loader: () => getAuth(),
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
  const initialAuth = Route.useLoaderData();
  return (
    <RootDocument>
      <AuthKitProvider initialAuth={initialAuth}>
        <TooltipProvider>
          <Outlet />
        </TooltipProvider>
      </AuthKitProvider>
    </RootDocument>
  );
}

function RootDocument({ children }: Readonly<{ children: ReactNode }>) {
  return (
    <html lang="en" suppressHydrationWarning>
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
