import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";

import type { LocalState } from "../../ipc/contracts.ts";

type LocalStateSubscription = {
  readonly localState: LocalState;
  readonly isLoading: boolean;
  readonly error: string | null;
};

type LocalStateContextValue = LocalStateSubscription & {
  readonly reload: () => void;
};

type LocalStateSubscriptionAction =
  | { readonly type: "loaded"; readonly localState: LocalState }
  | { readonly type: "changed"; readonly localState: LocalState }
  | { readonly type: "failed" };

export const initialLocalStateSubscription: LocalStateSubscription = {
  localState: {
    revision: 0,
    account: null,
    provider: { known: false, value: null },
    capability: { status: "OFFLINE" },
    snippets: [],
  },
  isLoading: true,
  error: null,
};

export const updateLocalStateSubscription = (
  state: LocalStateSubscription,
  action: LocalStateSubscriptionAction,
): LocalStateSubscription => {
  if (action.type === "failed") {
    return { ...state, isLoading: false, error: "Couldn’t load Plakk’s local state." };
  }
  return {
    localState:
      action.localState.revision >= state.localState.revision
        ? action.localState
        : state.localState,
    isLoading: false,
    error: null,
  };
};

const LocalStateContext = createContext<LocalStateContextValue | null>(null);

export function LocalStateProvider({ children }: { readonly children: ReactNode }) {
  const [state, setState] = useState(initialLocalStateSubscription);

  const reload = useCallback(() => {
    void window.ipc.localState.get().then(
      (localState) =>
        setState((current) =>
          updateLocalStateSubscription(current, { type: "loaded", localState }),
        ),
      () => setState((current) => updateLocalStateSubscription(current, { type: "failed" })),
    );
  }, []);

  useEffect(() => {
    let mounted = true;
    const apply = (action: LocalStateSubscriptionAction) => {
      if (mounted) setState((current) => updateLocalStateSubscription(current, action));
    };
    const unsubscribe = window.ipc.localState.onChanged((localState) =>
      apply({ type: "changed", localState }),
    );
    void window.ipc.localState.get().then(
      (localState) => apply({ type: "loaded", localState }),
      () => apply({ type: "failed" }),
    );
    return () => {
      mounted = false;
      unsubscribe();
    };
  }, [reload]);

  const value = useMemo(() => ({ ...state, reload }), [reload, state]);
  return <LocalStateContext value={value}>{children}</LocalStateContext>;
}

export function useLocalState(): LocalStateContextValue {
  const value = useContext(LocalStateContext);
  if (value === null) {
    throw new Error("Local state must be used inside LocalStateProvider.");
  }
  return value;
}
