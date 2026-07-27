import { useAccessToken, useAuth } from "@workos/authkit-tanstack-react-start/client";
import type { StorageProvider } from "@plakk/shared";
import type { StorageOnboardingOrigin } from "@plakk/shared/PlakkApi";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as ManagedRuntime from "effect/ManagedRuntime";
import {
  useCallback,
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
} from "./account-product-lifetime.ts";
import {
  AccountProductReader,
  makeAccountProductReaderLayer,
  resolveProductRpcUrl,
} from "./product-reader.ts";
import { makeBrowserAccountProductMirrorLayer } from "./browser-readable-mirror.ts";
import type { AccountProductMirror } from "./readable-mirror.ts";
import {
  makeStorageOnboardingClientLayer,
  StorageOnboardingClient,
} from "./storage-onboarding-client.ts";
import { WebProductContext, type WebProductContextValue } from "./web-product-context.tsx";

class WorkOsSignOutFailure extends Data.TaggedError("WorkOsSignOutFailure")<{
  readonly cause: unknown;
}> {}

const signedOutContext: WebProductContextValue = {
  refresh: null,
  retry: null,
  signOut: null,
  state: { kind: "idle" },
  storageOnboarding: null,
};

function ActiveIdentityProduct(props: {
  readonly children: ReactNode;
  readonly lifetime: AccountProductLifetimeShape;
  readonly runtime: ManagedRuntime.ManagedRuntime<
    AccountProductLifetime | StorageOnboardingClient,
    never
  >;
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
  const refresh = useCallback(() => runtime.runPromise(lifetime.refresh), [lifetime, runtime]);
  const begin = useCallback(
    (provider: StorageProvider, origin: StorageOnboardingOrigin) =>
      runtime.runPromise(
        Effect.flatMap(StorageOnboardingClient, (client) => client.begin(provider, origin)),
      ),
    [runtime],
  );
  const read = useCallback(
    (providerHint: StorageProvider | null) =>
      runtime.runPromise(
        Effect.flatMap(StorageOnboardingClient, (client) => client.read(providerHint)),
      ),
    [runtime],
  );

  return (
    <WebProductContext.Provider
      value={{
        refresh,
        retry,
        signOut,
        state,
        storageOnboarding: { begin, read },
      }}
    >
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
  readonly storageOnboardingLayer: Layer.Layer<StorageOnboardingClient>;
}) {
  const { accountId, children, delegateSignOut, readerLayer, storageOnboardingLayer } = props;
  // The account-keyed ProductIdentityBoundary remounts this resource; live layer swaps are unsupported.
  const mirrorLayer = useState(
    () => props.mirrorLayer ?? makeBrowserAccountProductMirrorLayer(accountId),
  )[0];
  type IdentityRuntime = {
    readonly lifetimePromise: Promise<AccountProductLifetimeShape>;
    readonly runtime: ManagedRuntime.ManagedRuntime<
      AccountProductLifetime | StorageOnboardingClient,
      never
    >;
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
      Layer.merge(
        AccountProductLifetime.layer.pipe(Layer.provide(Layer.merge(readerLayer, mirrorLayer))),
        storageOnboardingLayer,
      ),
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
  }, [accountId, initializationAttempt, mirrorLayer, readerLayer, storageOnboardingLayer]);

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
  const refresh = useCallback(async () => {
    const resource = resourceRef.current;
    if (resource === null) {
      throw new Error("The account product is not initialized.");
    }
    const productLifetime = await resource.lifetimePromise;
    await resource.runtime.runPromise(productLifetime.refresh);
  }, []);

  if (activeResource === null) {
    return (
      <WebProductContext.Provider
        value={{
          retry:
            initializationFailure === null
              ? null
              : () => setInitializationAttempt((attempt) => attempt + 1),
          refresh,
          signOut,
          state:
            initializationFailure === null
              ? { accountId, kind: "loading" }
              : { accountId, cause: initializationFailure, kind: "failed" },
          storageOnboarding: null,
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
  readonly storageOnboardingLayer: Layer.Layer<StorageOnboardingClient>;
}) {
  return <IdentityProductResource key={props.accountId} {...props} />;
}

export function WebProductProvider({ children }: Readonly<{ children: ReactNode }>) {
  const auth = useAuth();
  const { getAccessToken } = useAccessToken();
  const getAccessTokenRef = useRef(getAccessToken);
  getAccessTokenRef.current = getAccessToken;
  const rpcUrl = resolveProductRpcUrl(import.meta.env.VITE_PLAKK_API_ORIGIN, import.meta.env.DEV);
  const [readerLayer, storageOnboardingLayer] = useState(
    () =>
      [
        makeAccountProductReaderLayer({
          getAccessToken: () => getAccessTokenRef.current(),
          rpcUrl,
        }),
        makeStorageOnboardingClientLayer({
          getAccessToken: () => getAccessTokenRef.current(),
          rpcUrl,
        }),
      ] as const,
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
      storageOnboardingLayer={storageOnboardingLayer}
    >
      {children}
    </ProductIdentityBoundary>
  );
}

export { useWebProduct } from "./web-product-context.tsx";
