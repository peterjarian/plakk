import type { AuthStatus } from "../ipc/contracts.ts";

type TrayAuthController = {
  disable(): void;
  setup(): void;
};

export function reconcileTrayAuth(
  status: Pick<AuthStatus, "user">,
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
