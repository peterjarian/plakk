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
import { BillingClient } from "./billing-client.ts";
import { AccountProductReader, resolveProductRpcUrl } from "./product-reader.ts";
import { makeBrowserAccountProductMirrorLayer } from "./browser-readable-mirror.ts";
import type { AccountProductMirror } from "./readable-mirror.ts";
import { StorageOnboardingClient } from "./storage-onboarding-client.ts";
import {
  webSnippetActionBrowserLayer,
  WebSnippetActionRemote,
  WebSnippetActions,
  type WebSnippetActions as WebSnippetActionsService,
} from "./snippet-actions.ts";
import {
  makeWebProviderTransferLayer,
  WebSnippetUploadRemote,
  WebSnippetUploads,
  type WebSnippetUploadsShape,
} from "./snippet-upload.ts";
import { makeWebProductClientLayer } from "./web-product-client-layer.ts";
import { WebProductContext, type WebProductContextValue } from "./web-product-context.tsx";

class WorkOsSignOutFailure extends Data.TaggedError("WorkOsSignOutFailure")<{
  readonly cause: unknown;
}> {}

const signedOutContext: WebProductContextValue = {
  billing: null,
  refresh: null,
  retry: null,
  signOut: null,
  state: { kind: "idle" },
  storageOnboarding: null,
  snippetActions: null,
  snippetUploads: null,
};

function ActiveIdentityProduct(props: {
  readonly children: ReactNode;
  readonly lifetime: AccountProductLifetimeShape;
  readonly runtime: ManagedRuntime.ManagedRuntime<
    | AccountProductLifetime
    | BillingClient
    | StorageOnboardingClient
    | WebSnippetActions
    | WebSnippetUploads,
    never
  >;
  readonly billing: BillingClient["Service"];
  readonly signOut: () => Promise<void>;
  readonly uploads: WebSnippetUploadsShape;
  readonly actions: WebSnippetActionsService["Service"];
}) {
  const { actions, billing, children, lifetime, runtime, signOut, uploads } = props;
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
        billing: {
          beginCheckout: (plan) => runtime.runPromise(billing.beginCheckout(plan)),
          openPortal: () => runtime.runPromise(billing.openPortal),
        },
        refresh,
        retry,
        signOut,
        state,
        storageOnboarding: { begin, read },
        snippetActions: {
          copy: (snippet) => runtime.runPromise(actions.copy(snippet)),
          delete: (snippetId) =>
            runtime.runPromise(actions.delete(snippetId).pipe(Effect.andThen(lifetime.refresh))),
          download: (snippet) => runtime.runPromise(actions.download(snippet)),
          open: (confirmedUrl) => runtime.runPromise(actions.open(confirmedUrl)),
          prepareOpen: (snippet) => runtime.runPromise(actions.prepareOpen(snippet)),
        },
        snippetUploads: {
          dismiss: (id) => runtime.runPromise(uploads.dismiss(id)),
          upload: (input) => runtime.runPromise(uploads.upload(input)),
        },
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
  readonly productClientLayer: Layer.Layer<
    | AccountProductReader
    | BillingClient
    | StorageOnboardingClient
    | WebSnippetActionRemote
    | WebSnippetUploadRemote
  >;
}) {
  const { accountId, children, delegateSignOut, productClientLayer } = props;
  // The account-keyed ProductIdentityBoundary remounts this resource; live layer swaps are unsupported.
  const mirrorLayer = useState(
    () => props.mirrorLayer ?? makeBrowserAccountProductMirrorLayer(accountId),
  )[0];
  type IdentityRuntime = {
    readonly productPromise: Promise<{
      readonly actions: WebSnippetActionsService["Service"];
      readonly billing: BillingClient["Service"];
      readonly lifetime: AccountProductLifetimeShape;
      readonly uploads: WebSnippetUploadsShape;
    }>;
    readonly runtime: ManagedRuntime.ManagedRuntime<
      | AccountProductLifetime
      | BillingClient
      | StorageOnboardingClient
      | WebSnippetActions
      | WebSnippetUploads,
      never
    >;
  };
  type ActiveIdentityRuntime = IdentityRuntime & {
    readonly actions: WebSnippetActionsService["Service"];
    readonly billing: BillingClient["Service"];
    readonly lifetime: AccountProductLifetimeShape;
    readonly uploads: WebSnippetUploadsShape;
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
    const providerTransferLayer = makeWebProviderTransferLayer();
    const snippetActionsLayer = WebSnippetActions.layer.pipe(
      Layer.provide(Layer.merge(productClientLayer, webSnippetActionBrowserLayer)),
    );
    const snippetUploadsLayer = WebSnippetUploads.layer.pipe(
      Layer.provide(Layer.merge(productClientLayer, providerTransferLayer)),
    );
    const runtime = ManagedRuntime.make(
      Layer.mergeAll(
        AccountProductLifetime.layer.pipe(
          Layer.provide(Layer.mergeAll(productClientLayer, mirrorLayer, snippetUploadsLayer)),
        ),
        productClientLayer,
        snippetActionsLayer,
        snippetUploadsLayer,
      ),
    );
    const productPromise = runtime.runPromise(
      Effect.all({
        actions: WebSnippetActions,
        billing: BillingClient,
        lifetime: AccountProductLifetime,
        uploads: WebSnippetUploads,
      }),
    );
    const resource = { productPromise, runtime };
    resourceRef.current = resource;
    void productPromise.then(
      ({ actions, billing, lifetime, uploads }) => {
        if (!mounted) return;
        runtime.runFork(lifetime.enter(accountId));
        setActiveResource({ ...resource, actions, billing, lifetime, uploads });
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
  }, [accountId, initializationAttempt, mirrorLayer, productClientLayer]);

  const signOut = useCallback(async () => {
    const resource = resourceRef.current;
    if (resource === null) {
      await delegateSignOut();
      return;
    }
    let productLifetime: AccountProductLifetimeShape;
    try {
      productLifetime = (await resource.productPromise).lifetime;
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
    const productLifetime = (await resource.productPromise).lifetime;
    await resource.runtime.runPromise(productLifetime.refresh);
  }, []);

  if (activeResource === null) {
    return (
      <WebProductContext.Provider
        value={{
          billing: null,
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
          snippetActions: null,
          snippetUploads: null,
        }}
      >
        {children}
      </WebProductContext.Provider>
    );
  }

  return (
    <ActiveIdentityProduct
      lifetime={activeResource.lifetime}
      actions={activeResource.actions}
      billing={activeResource.billing}
      runtime={activeResource.runtime}
      signOut={signOut}
      uploads={activeResource.uploads}
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
  readonly productClientLayer: Layer.Layer<
    | AccountProductReader
    | BillingClient
    | StorageOnboardingClient
    | WebSnippetActionRemote
    | WebSnippetUploadRemote
  >;
}) {
  return <IdentityProductResource key={props.accountId} {...props} />;
}

export function WebProductProvider({ children }: Readonly<{ children: ReactNode }>) {
  const auth = useAuth();
  const { getAccessToken } = useAccessToken();
  const getAccessTokenRef = useRef(getAccessToken);
  getAccessTokenRef.current = getAccessToken;
  const rpcUrl = resolveProductRpcUrl(import.meta.env.VITE_PLAKK_API_ORIGIN, import.meta.env.DEV);
  const productClientLayer = useState(() =>
    makeWebProductClientLayer({
      getAccessToken: () => getAccessTokenRef.current(),
      rpcUrl,
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
      productClientLayer={productClientLayer}
    >
      {children}
    </ProductIdentityBoundary>
  );
}

export { useWebProduct } from "./web-product-context.tsx";
