import { describe, expect, it } from "vite-plus/test";

import type { LocalState } from "../../ipc/contracts.ts";
import { initialLocalStateSubscription, updateLocalStateSubscription } from "./useLocalState.tsx";

const localState = (revision: number): LocalState => ({
  revision,
  user: null,
  capability: {
    status: "OFFLINE",
    storageProvider: { known: false, value: null },
  },
  syncStatus: null,
  storageUsageBytes: 0,
  snippets: [],
});

describe("local state subscription", () => {
  it("does not lose a subscription update when the initial snapshot resolves later", () => {
    const changed = updateLocalStateSubscription(initialLocalStateSubscription, {
      type: "changed",
      localState: localState(2),
    });
    const lateSnapshot = updateLocalStateSubscription(changed, {
      type: "loaded",
      localState: localState(1),
    });

    expect(lateSnapshot.localState.revision).toBe(2);
    expect(lateSnapshot.isLoading).toBe(false);
  });
});
