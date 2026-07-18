import type { User } from "@plakk/shared";

export type DesktopAuthState = {
  readonly user: User | null;
};

type TrayAuthController = {
  disable(): void;
  setup(): void;
};

export function reconcileTrayAuth(
  status: DesktopAuthState,
  controller: TrayAuthController | undefined,
) {
  if (status.user === null) {
    controller?.disable();
    return;
  }
  controller?.setup();
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
