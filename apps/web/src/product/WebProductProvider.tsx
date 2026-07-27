import { useAccessToken, useAuth } from "@workos/authkit-tanstack-react-start/client";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as ManagedRuntime from "effect/ManagedRuntime";
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
  AccountProductLifetime,
  clearProductThenSignOut,
  type AccountProductLifetimeShape,
  type AccountProductState,
} from "./account-product-lifetime.ts";
import {
  AccountProductReader,
  makeAccountProductReaderLayer,
  resolveProductRpcUrl,
} from "./product-reader.ts";

type WebProductContextValue = {
  readonly retry: () => void;
  readonly signOut: () => Promise<void>;
  readonly state: AccountProductState;
};

const WebProductContext = createContext<WebProductContextValue | null>(null);

class WorkOsSignOutFailure extends Data.TaggedError("WorkOsSignOutFailure")<{
  readonly cause: unknown;
}> {}

const idleContext: WebProductContextValue = {
  retry: () => undefined,
  signOut: () => Promise.resolve(),
  state: { kind: "idle" },
};

function ActiveIdentityProduct(props: {
  readonly children: ReactNode;
  readonly delegateSignOut: () => Promise<void>;
  readonly lifetime: AccountProductLifetimeShape;
  readonly runtime: ManagedRuntime.ManagedRuntime<AccountProductLifetime, never>;
}) {
  const { children, delegateSignOut, lifetime, runtime } = props;
  const state = useSyncExternalStore(
    lifetime.subscribe,
    lifetime.getSnapshot,
    lifetime.getSnapshot,
  );

  const retry = useCallback(() => {
    runtime.runFork(lifetime.retry);
  }, [lifetime, runtime]);

  const signOut = useCallback(
    () =>
      runtime.runPromise(
        clearProductThenSignOut(
          lifetime.clear,
          Effect.tryPromise({
            try: delegateSignOut,
            catch: (cause) => new WorkOsSignOutFailure({ cause }),
          }),
        ),
      ),
    [delegateSignOut, lifetime, runtime],
  );

  return (
    <WebProductContext.Provider value={{ retry, signOut, state }}>
      {children}
    </WebProductContext.Provider>
  );
}

export function ProductIdentityBoundary(props: {
  readonly accountId: string;
  readonly children: ReactNode;
  readonly delegateSignOut: () => Promise<void>;
  readonly readerLayer: Layer.Layer<AccountProductReader>;
}) {
  const { accountId, children, delegateSignOut, readerLayer } = props;
  const [runtime] = useState(() =>
    ManagedRuntime.make(AccountProductLifetime.layer.pipe(Layer.provide(readerLayer))),
  );
  const [lifetime, setLifetime] = useState<AccountProductLifetimeShape | null>(null);

  useEffect(() => {
    let mounted = true;
    void runtime.runPromise(AccountProductLifetime).then((productLifetime) => {
      if (!mounted) return;
      runtime.runFork(productLifetime.enter(accountId));
      setLifetime(productLifetime);
    });
    return () => {
      mounted = false;
      void runtime.dispose();
    };
  }, [accountId, runtime]);

  if (lifetime === null) {
    return (
      <WebProductContext.Provider value={{ ...idleContext, state: { accountId, kind: "loading" } }}>
        {children}
      </WebProductContext.Provider>
    );
  }

  return (
    <ActiveIdentityProduct delegateSignOut={delegateSignOut} lifetime={lifetime} runtime={runtime}>
      {children}
    </ActiveIdentityProduct>
  );
}

export function WebProductProvider({ children }: Readonly<{ children: ReactNode }>) {
  const auth = useAuth();
  const { getAccessToken } = useAccessToken();
  const getAccessTokenRef = useRef(getAccessToken);
  getAccessTokenRef.current = getAccessToken;
  const readerLayer = useState(() =>
    makeAccountProductReaderLayer({
      getAccessToken: () => getAccessTokenRef.current(),
      rpcUrl: resolveProductRpcUrl(import.meta.env.VITE_PLAKK_API_ORIGIN),
    }),
  )[0];

  if (auth.loading || auth.user === null) {
    return <WebProductContext.Provider value={idleContext}>{children}</WebProductContext.Provider>;
  }

  return (
    <ProductIdentityBoundary
      key={auth.user.id}
      accountId={auth.user.id}
      delegateSignOut={() => auth.signOut({ returnTo: "/" })}
      readerLayer={readerLayer}
    >
      {children}
    </ProductIdentityBoundary>
  );
}

export const useWebProduct = (): WebProductContextValue => {
  const product = useContext(WebProductContext);
  if (product === null) {
    throw new Error("useWebProduct must be used within WebProductProvider.");
  }
  return product;
};
