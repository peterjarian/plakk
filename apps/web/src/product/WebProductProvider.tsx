import { useAccessToken, useAuth } from "@workos/authkit-tanstack-react-start/client";
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from "react";

import {
  clearProductThenSignOut,
  createAccountProductLifetime,
  type AccountProductState,
} from "./account-product-lifetime.ts";
import { makeWebProductReader, resolveProductRpcUrl } from "./product-reader.ts";

type WebProductContextValue = {
  readonly retry: () => void;
  readonly signOut: () => Promise<void>;
  readonly state: AccountProductState;
};

const WebProductContext = createContext<WebProductContextValue | null>(null);

export function WebProductProvider({ children }: Readonly<{ children: ReactNode }>) {
  const auth = useAuth();
  const { getAccessToken } = useAccessToken();
  const getAccessTokenRef = useRef(getAccessToken);
  getAccessTokenRef.current = getAccessToken;
  const [lifetime] = useState(() =>
    createAccountProductLifetime(
      makeWebProductReader({
        getAccessToken: () => getAccessTokenRef.current(),
        rpcUrl: resolveProductRpcUrl(import.meta.env.VITE_PLAKK_API_ORIGIN),
      }),
    ),
  );
  const state = useSyncExternalStore(
    lifetime.subscribe,
    lifetime.getSnapshot,
    lifetime.getSnapshot,
  );

  useEffect(() => {
    if (auth.loading) return;
    if (auth.user === null) {
      void lifetime.clear();
      return;
    }
    lifetime.enter(auth.user.id);
  }, [auth.loading, auth.user, lifetime]);

  useEffect(
    () => () => {
      void lifetime.clear();
    },
    [lifetime],
  );

  const signOut = useCallback(async () => {
    await clearProductThenSignOut(lifetime.clear, () => auth.signOut({ returnTo: "/" }));
  }, [auth, lifetime]);

  return (
    <WebProductContext.Provider value={{ retry: lifetime.retry, signOut, state }}>
      {children}
    </WebProductContext.Provider>
  );
}

export const useWebProduct = (): WebProductContextValue => {
  const product = useContext(WebProductContext);
  if (product === null) {
    throw new Error("useWebProduct must be used within WebProductProvider.");
  }
  return product;
};
