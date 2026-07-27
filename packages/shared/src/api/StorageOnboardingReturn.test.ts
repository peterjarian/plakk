import { describe, expect, it } from "vite-plus/test";

import {
  parseStorageOnboardingRouteSearch,
  storageOnboardingRouteSearchParams,
} from "./StorageOnboardingReturn.ts";

describe("storage route search", () => {
  it("round-trips the explicit management entry without confusing it with authorization return", () => {
    const params = storageOnboardingRouteSearchParams({
      confirmation: undefined,
      mode: "manage",
      origin: undefined,
      provider: null,
    });

    expect(params.toString()).toBe("mode=manage");
    expect(parseStorageOnboardingRouteSearch((key) => params.get(key))).toEqual({
      confirmation: undefined,
      mode: "manage",
      origin: undefined,
      provider: null,
    });
  });

  it("drops unknown management modes", () => {
    expect(
      parseStorageOnboardingRouteSearch((key) => (key === "mode" ? "destroy" : undefined)),
    ).toEqual({
      confirmation: undefined,
      mode: undefined,
      origin: undefined,
      provider: null,
    });
  });
});
