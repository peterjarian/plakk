import type { DesktopApi } from "./index.ts";

export {};

declare global {
  interface Window {
    ipc: DesktopApi;
  }
}
