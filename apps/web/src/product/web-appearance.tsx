import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from "react";

export type WebAppearancePreference = "dark" | "light" | "system";
export type EffectiveWebAppearance = Exclude<WebAppearancePreference, "system">;

export const WEB_APPEARANCE_STORAGE_KEY = "plakk.web.appearance";

export const WEB_APPEARANCE_BOOTSTRAP_SCRIPT = `(() => {
  const root = document.documentElement;
  let preference = "system";
  try {
    const stored = window.localStorage.getItem("${WEB_APPEARANCE_STORAGE_KEY}");
    if (stored === "dark" || stored === "light" || stored === "system") preference = stored;
  } catch {}
  let systemPrefersDark = false;
  try {
    systemPrefersDark = window.matchMedia("(prefers-color-scheme: dark)").matches;
  } catch {}
  const effectiveAppearance =
    preference === "system" ? (systemPrefersDark ? "dark" : "light") : preference;
  root.dataset.appearance = preference;
  root.dataset.effectiveAppearance = effectiveAppearance;
  root.classList.toggle("dark", effectiveAppearance === "dark");
  root.style.colorScheme = effectiveAppearance;
})();`;

type AppearanceRoot = {
  readonly classList: { toggle(token: string, force?: boolean): boolean };
  readonly dataset: DOMStringMap;
  readonly style: { colorScheme: string };
};

type AppearanceStorage = {
  readonly getItem: (key: string) => string | null;
};

export function readWebAppearancePreference(storage: AppearanceStorage): WebAppearancePreference {
  try {
    const stored = storage.getItem(WEB_APPEARANCE_STORAGE_KEY);
    return stored === "dark" || stored === "light" || stored === "system" ? stored : "system";
  } catch {
    return "system";
  }
}

export const effectiveWebAppearance = (
  preference: WebAppearancePreference,
  systemPrefersDark: boolean,
): EffectiveWebAppearance =>
  preference === "system" ? (systemPrefersDark ? "dark" : "light") : preference;

export function applyWebAppearance(
  root: AppearanceRoot,
  preference: WebAppearancePreference,
  effective: EffectiveWebAppearance,
): void {
  root.dataset.appearance = preference;
  root.dataset.effectiveAppearance = effective;
  root.classList.toggle("dark", effective === "dark");
  root.style.colorScheme = effective;
}

type WebAppearanceContextValue = {
  readonly preference: WebAppearancePreference;
  readonly setPreference: (preference: WebAppearancePreference) => void;
};

const WebAppearanceContext = createContext<WebAppearanceContextValue | null>(null);

export function WebAppearanceProvider({ children }: Readonly<{ children: ReactNode }>) {
  const [preference, setPreferenceState] = useState<WebAppearancePreference>("system");
  const [systemPrefersDark, setSystemPrefersDark] = useState(false);
  const [isHydrated, setIsHydrated] = useState(false);

  useEffect(() => {
    const media = window.matchMedia("(prefers-color-scheme: dark)");
    const update = () => setSystemPrefersDark(media.matches);
    const persistedPreference = readWebAppearancePreference(window.localStorage);
    setPreferenceState(persistedPreference);
    update();
    applyWebAppearance(
      document.documentElement,
      persistedPreference,
      effectiveWebAppearance(persistedPreference, media.matches),
    );
    setIsHydrated(true);
    media.addEventListener("change", update);
    return () => media.removeEventListener("change", update);
  }, []);

  useEffect(() => {
    if (!isHydrated) return;
    applyWebAppearance(
      document.documentElement,
      preference,
      effectiveWebAppearance(preference, systemPrefersDark),
    );
  }, [isHydrated, preference, systemPrefersDark]);

  useEffect(() => {
    const synchronize = (event: StorageEvent) => {
      if (event.key !== WEB_APPEARANCE_STORAGE_KEY) return;
      setPreferenceState(readWebAppearancePreference(window.localStorage));
    };
    window.addEventListener("storage", synchronize);
    return () => window.removeEventListener("storage", synchronize);
  }, []);

  const setPreference = useCallback((next: WebAppearancePreference) => {
    try {
      window.localStorage.setItem(WEB_APPEARANCE_STORAGE_KEY, next);
    } catch {
      // Appearance still applies for this page lifetime when browser persistence is unavailable.
    }
    setPreferenceState(next);
  }, []);

  return (
    <WebAppearanceContext.Provider value={{ preference, setPreference }}>
      {children}
    </WebAppearanceContext.Provider>
  );
}

export function useWebAppearance(): WebAppearanceContextValue {
  const appearance = useContext(WebAppearanceContext);
  if (appearance === null) {
    throw new Error("useWebAppearance must be used inside WebAppearanceProvider.");
  }
  return appearance;
}
