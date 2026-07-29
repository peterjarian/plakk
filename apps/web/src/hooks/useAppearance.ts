import { useEffect, useState } from "react";

export type Appearance = "light" | "dark" | "system";

export function useAppearance() {
  const [preference, setPreference] = useState<Appearance>(() => {
    if (typeof localStorage === "undefined") return "system";
    const stored = localStorage.getItem("plakk-appearance");
    return stored === "light" || stored === "dark" ? stored : "system";
  });

  useEffect(() => {
    const media = window.matchMedia("(prefers-color-scheme: dark)");
    const apply = () => {
      const dark = preference === "dark" || (preference === "system" && media.matches);
      document.documentElement.classList.toggle("dark", dark);
    };
    apply();
    media.addEventListener("change", apply);
    return () => media.removeEventListener("change", apply);
  }, [preference]);

  return {
    preference,
    set: async (next: Appearance) => {
      localStorage.setItem("plakk-appearance", next);
      setPreference(next);
    },
  };
}
