import { createRoot } from "react-dom/client";
import { TooltipProvider } from "@plakk/ui/components/primitives/tooltip";
import { Home } from "./views/Home.js";
import { Settings } from "./views/Settings.js";
import { Tray } from "./views/Tray.js";
import { Welcome } from "./views/Welcome.js";
import type { ComponentType } from "react";
import type { ViewType } from "./lib/navigate.js";

import "@plakk/ui/globals.css";

const views: Record<ViewType, ComponentType> = {
  home: Home,
  settings: Settings,
  tray: Tray,
  welcome: Welcome,
};

const view = new URLSearchParams(window.location.search).get("view") ?? "welcome";
const View: ComponentType = views[view as keyof typeof views] ?? Home;

createRoot(document.querySelector<HTMLDivElement>("#app")!).render(
  <TooltipProvider>
    <View />
  </TooltipProvider>,
);
