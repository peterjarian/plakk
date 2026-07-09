import { LoaderCircle } from "lucide-react";
import { useEffect } from "react";
import { createRoot } from "react-dom/client";
import { TooltipProvider } from "@plakk/ui/components/primitives/tooltip";
import { PlakkAtomProvider } from "@plakk/ui/hooks/useUploadFlow";
import { Home } from "./views/Home.tsx";
import { Settings } from "./views/Settings.tsx";
import { Tray } from "./views/Tray.tsx";
import { Welcome } from "./views/Welcome.tsx";
import type { ComponentType } from "react";
import type { ViewType } from "./lib/navigate.ts";
import { AuthProvider, useAuth } from "./hooks/useAuth.ts";
import { navigate } from "./lib/navigate.ts";

import "@plakk/ui/globals.css";

const views: Record<ViewType, ComponentType> = {
  home: Home,
  settings: Settings,
  tray: Tray,
  welcome: Welcome,
};

function Loading() {
  return (
    <main className="grid h-screen place-items-center bg-background text-muted-foreground">
      <LoaderCircle className="size-5 animate-spin" aria-label="Loading" />
    </main>
  );
}

function Bootstrap() {
  const auth = useAuth();

  useEffect(() => {
    if (!auth.isLoading) navigate(auth.user === null ? "welcome" : "home");
  }, [auth.isLoading, auth.user]);

  return <Loading />;
}

function ProtectedView({
  View,
  redirectOnSignOut = true,
}: {
  View: ComponentType;
  redirectOnSignOut?: boolean;
}) {
  const auth = useAuth();

  useEffect(() => {
    if (redirectOnSignOut && !auth.isLoading && auth.user === null) navigate("welcome");
  }, [auth.isLoading, auth.user, redirectOnSignOut]);

  if (auth.user === null) return auth.isLoading ? <Loading /> : null;
  return <View />;
}

const view = new URLSearchParams(window.location.search).get("view");
const View: ComponentType = view === null ? Bootstrap : (views[view as keyof typeof views] ?? Home);
const isProtectedView = view !== null && view !== "welcome";

createRoot(document.querySelector<HTMLDivElement>("#app")!).render(
  <TooltipProvider>
    <PlakkAtomProvider>
      <AuthProvider>
        {isProtectedView ? (
          <ProtectedView View={View} redirectOnSignOut={view !== "tray"} />
        ) : (
          <View />
        )}
      </AuthProvider>
    </PlakkAtomProvider>
  </TooltipProvider>,
);
