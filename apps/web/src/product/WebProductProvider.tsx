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
  AccountProductLifetimeInitializationFailure,
  clearProductThenSignOut,
  type AccountProductLifetimeShape,
  type AccountProductState,
} from "./account-product-lifetime.ts";
import {
  AccountProductReader,
  makeAccountProductReaderLayer,
  resolveProductRpcUrl,
} from "./product-reader.ts";
import { makeBrowserAccountProductMirrorLayer } from "./browser-readable-mirror.ts";
import type { AccountProductMirror } from "./readable-mirror.ts";

type WebProductContextValue = {
  readonly retry: (() => void) | null;
  readonly signOut: (() => Promise<void>) | null;
  readonly state: AccountProductState;
};

const WebProductContext = createContext<WebProductContextValue | null>(null);

class WorkOsSignOutFailure extends Data.TaggedError("WorkOsSignOutFailure")<{
  readonly cause: unknown;
}> {}

const signedOutContext: WebProductContextValue = {
  retry: null,
  signOut: null,
  state: { kind: "idle" },
};

function ActiveIdentityProduct(props: {
  readonly children: ReactNode;
  readonly lifetime: AccountProductLifetimeShape;
  readonly runtime: ManagedRuntime.ManagedRuntime<AccountProductLifetime, never>;
  readonly signOut: () => Promise<void>;
}) {
  const { children, lifetime, runtime, signOut } = props;
  const state = useSyncExternalStore(
    lifetime.subscribe,
    lifetime.getSnapshot,
    lifetime.getSnapshot,
  );

  const retry = useCallback(() => {
    runtime.runFork(lifetime.retry);
  }, [lifetime, runtime]);

  return (
    <WebProductContext.Provider value={{ retry, signOut, state }}>
      {children}
    </WebProductContext.Provider>
  );
}

function IdentityProductResource(props: {
  readonly accountId: string;
  readonly children: ReactNode;
  readonly delegateSignOut: () => Promise<void>;
  readonly mirrorLayer?: Layer.Layer<AccountProductMirror>;
  readonly readerLayer: Layer.Layer<AccountProductReader>;
}) {
  const { accountId, children, delegateSignOut, readerLayer } = props;
  // The account-keyed ProductIdentityBoundary remounts this resource; live layer swaps are unsupported.
  const mirrorLayer = useState(
    () => props.mirrorLayer ?? makeBrowserAccountProductMirrorLayer(accountId),
  )[0];
  type IdentityRuntime = {
    readonly lifetimePromise: Promise<AccountProductLifetimeShape>;
    readonly runtime: ManagedRuntime.ManagedRuntime<AccountProductLifetime, never>;
  };
  type ActiveIdentityRuntime = IdentityRuntime & {
    readonly lifetime: AccountProductLifetimeShape;
  };
  const resourceRef = useRef<IdentityRuntime | null>(null);
  const [activeResource, setActiveResource] = useState<ActiveIdentityRuntime | null>(null);
  const [initializationFailure, setInitializationFailure] =
    useState<AccountProductLifetimeInitializationFailure | null>(null);
  const [initializationAttempt, setInitializationAttempt] = useState(0);

  useEffect(() => {
    let mounted = true;
    setActiveResource(null);
    setInitializationFailure(null);
    const runtime = ManagedRuntime.make(
      AccountProductLifetime.layer.pipe(Layer.provide(Layer.merge(readerLayer, mirrorLayer))),
    );
    const lifetimePromise = runtime.runPromise(AccountProductLifetime);
    const resource = { lifetimePromise, runtime };
    resourceRef.current = resource;
    void lifetimePromise.then(
      (lifetime) => {
        if (!mounted) return;
        runtime.runFork(lifetime.enter(accountId));
        setActiveResource({ ...resource, lifetime });
      },
      (cause) => {
        if (!mounted) return;
        setInitializationFailure(new AccountProductLifetimeInitializationFailure({ cause }));
      },
    );
    return () => {
      mounted = false;
      if (resourceRef.current === resource) resourceRef.current = null;
      void runtime.dispose();
    };
  }, [accountId, initializationAttempt, mirrorLayer, readerLayer]);

  const signOut = useCallback(async () => {
    const resource = resourceRef.current;
    if (resource === null) {
      await delegateSignOut();
      return;
    }
    let productLifetime: AccountProductLifetimeShape;
    try {
      productLifetime = await resource.lifetimePromise;
    } catch {
      await delegateSignOut();
      return;
    }
    await resource.runtime.runPromise(
      clearProductThenSignOut(
        productLifetime.clear,
        Effect.tryPromise({
          try: delegateSignOut,
          catch: (cause) => new WorkOsSignOutFailure({ cause }),
        }),
        productLifetime.enter(accountId),
      ),
    );
  }, [accountId, delegateSignOut]);

  if (activeResource === null) {
    return (
      <WebProductContext.Provider
        value={{
          retry:
            initializationFailure === null
              ? null
              : () => setInitializationAttempt((attempt) => attempt + 1),
          signOut,
          state:
            initializationFailure === null
              ? { accountId, kind: "loading" }
              : { accountId, cause: initializationFailure, kind: "failed" },
        }}
      >
        {children}
      </WebProductContext.Provider>
    );
  }

  return (
    <ActiveIdentityProduct
      lifetime={activeResource.lifetime}
      runtime={activeResource.runtime}
      signOut={signOut}
    >
      {children}
    </ActiveIdentityProduct>
  );
}

export function ProductIdentityBoundary(props: {
  readonly accountId: string;
  readonly children: ReactNode;
  readonly delegateSignOut: () => Promise<void>;
  readonly mirrorLayer?: Layer.Layer<AccountProductMirror>;
  readonly readerLayer: Layer.Layer<AccountProductReader>;
}) {
  return <IdentityProductResource key={props.accountId} {...props} />;
}

export function WebProductProvider({ children }: Readonly<{ children: ReactNode }>) {
  const auth = useAuth();
  const { getAccessToken } = useAccessToken();
  const getAccessTokenRef = useRef(getAccessToken);
  getAccessTokenRef.current = getAccessToken;
  const readerLayer = useState(() =>
    makeAccountProductReaderLayer({
      getAccessToken: () => getAccessTokenRef.current(),
      rpcUrl: resolveProductRpcUrl(import.meta.env.VITE_PLAKK_API_ORIGIN, import.meta.env.DEV),
    }),
  )[0];

  if (auth.user === null) {
    return (
      <WebProductContext.Provider value={signedOutContext}>{children}</WebProductContext.Provider>
    );
  }

  return (
    <ProductIdentityBoundary
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
