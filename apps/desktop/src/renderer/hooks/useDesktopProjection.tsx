import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";

import type { DesktopProjection } from "../../ipc/contracts.ts";

type DesktopProjectionSubscription = {
  readonly projection: DesktopProjection;
  readonly isLoading: boolean;
  readonly error: string | null;
};

type DesktopProjectionContextValue = DesktopProjectionSubscription & {
  readonly reload: () => void;
};

type DesktopProjectionSubscriptionAction =
  | { readonly type: "loaded"; readonly projection: DesktopProjection }
  | { readonly type: "changed"; readonly projection: DesktopProjection }
  | { readonly type: "failed" };

export const initialDesktopProjectionSubscription: DesktopProjectionSubscription = {
  projection: {
    revision: 0,
    account: null,
    provider: { known: false, value: null },
    capability: { status: "OFFLINE" },
    snippets: [],
  },
  isLoading: true,
  error: null,
};

export const updateDesktopProjectionSubscription = (
  state: DesktopProjectionSubscription,
  action: DesktopProjectionSubscriptionAction,
): DesktopProjectionSubscription => {
  if (action.type === "failed") {
    return { ...state, isLoading: false, error: "Couldn’t load Plakk’s local state." };
  }
  return {
    projection:
      action.projection.revision >= state.projection.revision
        ? action.projection
        : state.projection,
    isLoading: false,
    error: null,
  };
};

const DesktopProjectionContext = createContext<DesktopProjectionContextValue | null>(null);

export function DesktopProjectionProvider({ children }: { readonly children: ReactNode }) {
  const [state, setState] = useState(initialDesktopProjectionSubscription);

  const reload = useCallback(() => {
    void window.ipc.projection.get().then(
      (projection) =>
        setState((current) =>
          updateDesktopProjectionSubscription(current, { type: "loaded", projection }),
        ),
      () => setState((current) => updateDesktopProjectionSubscription(current, { type: "failed" })),
    );
  }, []);

  useEffect(() => {
    let mounted = true;
    const apply = (action: DesktopProjectionSubscriptionAction) => {
      if (mounted) setState((current) => updateDesktopProjectionSubscription(current, action));
    };
    const unsubscribe = window.ipc.projection.onChanged((projection) =>
      apply({ type: "changed", projection }),
    );
    void window.ipc.projection.get().then(
      (projection) => apply({ type: "loaded", projection }),
      () => apply({ type: "failed" }),
    );
    return () => {
      mounted = false;
      unsubscribe();
    };
  }, [reload]);

  const value = useMemo(() => ({ ...state, reload }), [reload, state]);
  return <DesktopProjectionContext value={value}>{children}</DesktopProjectionContext>;
}

export function useDesktopProjection(): DesktopProjectionContextValue {
  const value = useContext(DesktopProjectionContext);
  if (value === null) {
    throw new Error("Desktop projection must be used inside DesktopProjectionProvider.");
  }
  return value;
}
