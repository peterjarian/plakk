import type { User } from "@plakk/shared";
import { resolve } from "node:path";

export type DesktopTrayState = {
  readonly canIngest: boolean;
  readonly toolbarWidgetEnabled: boolean;
  readonly user: User | null;
};

type TrayLifecycleController = {
  disable(): void;
  setAccountState(resolved: boolean, canIngest: boolean): void;
  setup(): void;
};

export function resolveDesktopUserDataPath(
  defaultPath: string,
  configuredPath: string | undefined,
) {
  const value = configuredPath?.trim();
  return value ? resolve(value) : defaultPath;
}

export function reconcileTrayLifecycle(
  state: DesktopTrayState,
  controller: TrayLifecycleController | undefined,
) {
  if (!state.toolbarWidgetEnabled || state.user === null) {
    controller?.disable();
    return;
  }
  controller?.setup();
  controller?.setAccountState(true, state.canIngest);
}

export function isReloadShortcut(
  input: {
    readonly control: boolean;
    readonly key: string;
    readonly meta: boolean;
    readonly type: string;
  },
  platform = process.platform,
) {
  if (input.type !== "keyDown") return false;
  const modifier = platform === "darwin" ? input.meta : input.control;
  return input.key === "F5" || (modifier && input.key.toLowerCase() === "r");
}
