export type ViewType = "home" | "settings" | "tray" | "welcome";
export type DesktopView = Extract<ViewType, "home" | "settings">;

let desktopView: DesktopView =
  new URLSearchParams(globalThis.location?.search ?? "").get("view") === "settings"
    ? "settings"
    : "home";
const listeners = new Set<() => void>();

export const getDesktopView = () => desktopView;
export const subscribeToDesktopView = (listener: () => void) => {
  listeners.add(listener);
  return () => listeners.delete(listener);
};

export const setDesktopView = (view: DesktopView) => {
  if (desktopView === view) return;
  desktopView = view;
  history.replaceState(null, "", `?view=${view}`);
  for (const listener of listeners) listener();
};

export const navigate = (view: ViewType) => {
  if (typeof window === "undefined") {
    throw new Error("navigate() should only be called from the renderer");
  }

  const current = new URLSearchParams(window.location.search).get("view");
  if ((current === "home" || current === "settings") && (view === "home" || view === "settings")) {
    setDesktopView(view);
    return;
  }

  window.location.search = `?view=${view}`;
};
