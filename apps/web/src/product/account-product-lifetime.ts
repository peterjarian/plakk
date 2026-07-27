import type { AccountStatus, ApiSnippet } from "@plakk/shared/PlakkApi";

export type AccountProductSnapshot = {
  readonly account: AccountStatus;
  readonly snippets: ReadonlyArray<ApiSnippet>;
};

export type AccountProductState =
  | { readonly kind: "idle" }
  | { readonly kind: "loading"; readonly accountId: string }
  | {
      readonly kind: "failed";
      readonly accountId: string;
      readonly message: string;
    }
  | ({
      readonly kind: "ready";
      readonly accountId: string;
    } & AccountProductSnapshot);

export interface AccountProductReader {
  readonly read: (accountId: string, signal: AbortSignal) => Promise<AccountProductSnapshot>;
}

export const clearProductThenSignOut = async (
  clear: () => Promise<void>,
  signOut: () => Promise<void>,
): Promise<void> => {
  await clear();
  await signOut();
};

export const createAccountProductLifetime = (reader: AccountProductReader) => {
  let state: AccountProductState = { kind: "idle" };
  let activeAccountId: string | null = null;
  let generation = 0;
  let controller: AbortController | null = null;
  const listeners = new Set<() => void>();

  const publish = (next: AccountProductState) => {
    state = next;
    for (const listener of listeners) listener();
  };

  const revoke = () => {
    generation += 1;
    controller?.abort();
    controller = null;
  };

  const load = (accountId: string) => {
    revoke();
    activeAccountId = accountId;
    controller = new AbortController();
    const loadGeneration = generation;
    const signal = controller.signal;
    publish({ accountId, kind: "loading" });

    void reader.read(accountId, signal).then(
      (snapshot) => {
        if (signal.aborted || generation !== loadGeneration || activeAccountId !== accountId) {
          return;
        }
        publish({ ...snapshot, accountId, kind: "ready" });
      },
      () => {
        if (signal.aborted || generation !== loadGeneration || activeAccountId !== accountId) {
          return;
        }
        publish({
          accountId,
          kind: "failed",
          message: "Plakk couldn’t load your snippets.",
        });
      },
    );
  };

  return {
    clear: (): Promise<void> => {
      revoke();
      activeAccountId = null;
      publish({ kind: "idle" });
      return Promise.resolve();
    },
    enter: (accountId: string): void => {
      if (activeAccountId === accountId) return;
      load(accountId);
    },
    getSnapshot: (): AccountProductState => state,
    retry: (): void => {
      if (activeAccountId !== null) load(activeAccountId);
    },
    subscribe: (listener: () => void): (() => void) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
};
