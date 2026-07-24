import type { AppearancePreference, AppearanceState } from "../ipc/contracts.ts";

const backgroundColors = {
  dark: "#0a0a0a",
  light: "#ffffff",
} as const;

type NativeThemeLike = {
  shouldUseDarkColors: boolean;
  themeSource: AppearancePreference;
  on(event: "updated", listener: () => void): unknown;
};

type AppearanceWindow<WebContents> = {
  readonly webContents: WebContents;
  isDestroyed(): boolean;
  setBackgroundColor(color: string): void;
};

type AppearanceControllerOptions<WebContents> = {
  readonly getWindows: () => ReadonlyArray<AppearanceWindow<WebContents>>;
  initialPreference: AppearancePreference;
  nativeTheme: NativeThemeLike;
  readonly sendState: (webContents: WebContents, state: AppearanceState) => void;
};

const effectiveAppearance = (nativeTheme: NativeThemeLike) =>
  nativeTheme.shouldUseDarkColors ? ("dark" as const) : ("light" as const);

export function createAppearanceController<WebContents>({
  getWindows,
  initialPreference,
  nativeTheme,
  sendState,
}: AppearanceControllerOptions<WebContents>) {
  let preference = initialPreference;
  nativeTheme.themeSource = preference;
  let state: AppearanceState = {
    preference,
    effective: effectiveAppearance(nativeTheme),
  };

  const getBackgroundColor = () => backgroundColors[state.effective];

  const reconcile = () => {
    const next: AppearanceState = {
      preference,
      effective: effectiveAppearance(nativeTheme),
    };
    if (next.preference === state.preference && next.effective === state.effective) return;

    state = next;
    const backgroundColor = getBackgroundColor();
    for (const window of getWindows()) {
      if (window.isDestroyed()) continue;
      window.setBackgroundColor(backgroundColor);
      sendState(window.webContents, state);
    }
  };

  nativeTheme.on("updated", reconcile);

  return {
    addToRendererUrl(url: URL) {
      url.searchParams.set("appearance", state.preference);
      url.searchParams.set("effectiveAppearance", state.effective);
      return url;
    },
    getBackgroundColor,
    getState: () => state,
    setPreference(next: AppearancePreference) {
      preference = next;
      nativeTheme.themeSource = next;
      reconcile();
    },
  };
}
