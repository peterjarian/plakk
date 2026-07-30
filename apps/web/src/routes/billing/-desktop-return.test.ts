import { describe, expect, it } from "vite-plus/test";

import { desktopBillingDeepLink } from "./desktop-return.tsx";

describe("desktop billing browser handoff", () => {
  it("opens the development app from the development web build", () => {
    expect(desktopBillingDeepLink(true)).toBe("plakk-dev://billing/success");
  });

  it("opens the packaged app from the production web build", () => {
    expect(desktopBillingDeepLink(false)).toBe("plakk://billing/success");
  });
});
