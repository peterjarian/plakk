import { useSyncExternalStore } from "react";

import type { AppearancePreference, AppearanceState } from "../../ipc/contracts.ts";

type AppearanceRoot = {
  readonly classList: { toggle(token: string, force?: boolean): boolean };
  readonly dataset: DOMStringMap;
  readonly style: { colorScheme: string };
};

let state: AppearanceState = { preference: "system", effective: "light" };
const listeners = new Set<() => void>();
let started = false;

export function applyAppearanceState(next: AppearanceState, root: AppearanceRoot): void {
  root.dataset.appearance = next.preference;
  root.dataset.effectiveAppearance = next.effective;
  root.classList.toggle("dark", next.effective === "dark");
  root.style.colorScheme = next.effective;
}

function updateAppearance(next: AppearanceState): void {
  applyAppearanceState(next, document.documentElement);
  if (next.preference === state.preference && next.effective === state.effective) return;
  state = next;
  for (const listener of listeners) listener();
}

export function startAppearanceSync(): void {
  if (started) return;
  started = true;

  const preference = document.documentElement.dataset.appearance;
  const effective = document.documentElement.dataset.effectiveAppearance;
  updateAppearance({
    preference:
      preference === "light" || preference === "dark" || preference === "system"
        ? preference
        : "system",
    effective: effective === "dark" ? "dark" : "light",
  });
  window.ipc.appearance.onChanged(updateAppearance);
  void window.ipc.appearance.get().then(updateAppearance, (error: unknown) => {
    console.error("Could not synchronize desktop appearance", error);
  });
}

export function useAppearance(): AppearanceState {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    () => state,
    () => state,
  );
}

export const setAppearancePreference = (preference: AppearancePreference) =>
  window.ipc.appearance.set(preference).then((next) => {
    updateAppearance(next);
  });
