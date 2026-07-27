import { describe, expect, it } from "vite-plus/test";

import {
  PLAKK_PRODUCTION_AUTH_CALLBACK_URL,
  PLAKK_PRODUCTION_IDENTITIES,
  PLAKK_PRODUCTION_STORAGE_RETURN_URL,
} from "./ProductionIdentities.ts";

describe("canonical Plakk production identities", () => {
  it("pins every public deployment to one exact HTTPS origin", () => {
    expect(PLAKK_PRODUCTION_IDENTITIES).toEqual({
      api: "https://api.plakk.io",
      desktopReleases: "https://releases.plakk.io",
      marketing: "https://plakk.io",
      web: "https://app.plakk.io",
    });

    for (const origin of Object.values(PLAKK_PRODUCTION_IDENTITIES)) {
      const url = new URL(origin);
      expect(url.protocol).toBe("https:");
      expect(url.origin).toBe(origin);
      expect(url.pathname).toBe("/");
    }
  });

  it("derives exact trusted AuthKit and storage returns from the Web identity", () => {
    expect(PLAKK_PRODUCTION_AUTH_CALLBACK_URL).toBe("https://app.plakk.io/api/auth/callback");
    expect(PLAKK_PRODUCTION_STORAGE_RETURN_URL).toBe("https://app.plakk.io/storage");
  });
});
