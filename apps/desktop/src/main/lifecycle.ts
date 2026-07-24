import type { User } from "@plakk/shared";
import { resolve } from "node:path";

export type DesktopTrayState = {
  readonly canIngest: boolean;
  readonly user: User | null;
};

type TrayWindowController = {
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

export function createToolbarWidgetLifecycle(
  controller: TrayWindowController,
  initialToolbarWidgetEnabled: boolean,
) {
  let accountState: DesktopTrayState = { canIngest: false, user: null };
  let toolbarWidgetEnabled = initialToolbarWidgetEnabled;

  function reconcile() {
    if (!toolbarWidgetEnabled || accountState.user === null) {
      controller.disable();
      return;
    }
    controller.setup();
    controller.setAccountState(true, accountState.canIngest);
  }

  return {
    applyAccountState(state: DesktopTrayState) {
      accountState = state;
      reconcile();
    },
    applyToolbarWidgetPreference(enabled: boolean) {
      toolbarWidgetEnabled = enabled;
      reconcile();
    },
  };
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
