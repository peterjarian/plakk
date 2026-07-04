export type ViewType = "home" | "settings" | "tray" | "welcome";

export const navigate = (view: ViewType) => {
  if (typeof window === "undefined") {
    throw new Error("navigate() should only be called from the renderer");
  }

  window.location.search = `?view=${view}`;
};
