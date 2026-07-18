import { describe, expect, it } from "vite-plus/test";

import type { DesktopProjection } from "../../ipc/contracts.ts";
import {
  initialDesktopProjectionSubscription,
  updateDesktopProjectionSubscription,
} from "./useDesktopProjection.tsx";

const projection = (revision: number): DesktopProjection => ({
  revision,
  account: null,
  provider: { known: false, value: null },
  capability: { status: "OFFLINE" },
  snippets: [],
});

describe("desktop projection subscription", () => {
  it("does not lose a subscription update when the initial snapshot resolves later", () => {
    const changed = updateDesktopProjectionSubscription(initialDesktopProjectionSubscription, {
      type: "changed",
      projection: projection(2),
    });
    const lateSnapshot = updateDesktopProjectionSubscription(changed, {
      type: "loaded",
      projection: projection(1),
    });

    expect(lateSnapshot.projection.revision).toBe(2);
    expect(lateSnapshot.isLoading).toBe(false);
  });
});
