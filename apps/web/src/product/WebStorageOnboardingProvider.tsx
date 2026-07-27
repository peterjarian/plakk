import { useAccessToken, useAuth } from "@workos/authkit-tanstack-react-start/client";
import * as Effect from "effect/Effect";
import * as ManagedRuntime from "effect/ManagedRuntime";
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";

import type { StorageProvider } from "@plakk/shared";
import type { StorageOnboardingOrigin } from "@plakk/shared/PlakkApi";

import { resolveProductRpcUrl } from "./product-reader.ts";
import {
  makeStorageOnboardingClientLayer,
  StorageOnboardingClient,
  type StorageOnboardingRead,
} from "./storage-onboarding-client.ts";

type WebStorageOnboardingContextValue = {
  readonly begin: (
    provider: StorageProvider,
    origin: StorageOnboardingOrigin,
  ) => Promise<{ readonly url: string }>;
  readonly read: (providerHint: StorageProvider | null) => Promise<StorageOnboardingRead>;
};

const WebStorageOnboardingContext = createContext<WebStorageOnboardingContextValue | null>(null);

function StorageIdentityBoundary({
  children,
  getAccessToken,
}: {
  readonly children: ReactNode;
  readonly getAccessToken: () => Promise<string | undefined>;
}) {
  const runtime = useState(() =>
    ManagedRuntime.make(
      makeStorageOnboardingClientLayer({
        getAccessToken,
        rpcUrl: resolveProductRpcUrl(import.meta.env.VITE_PLAKK_API_ORIGIN, import.meta.env.DEV),
      }),
    ),
  )[0];

  useEffect(
    () => () => {
      void runtime.dispose();
    },
    [runtime],
  );

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
    <WebStorageOnboardingContext.Provider value={{ begin, read }}>
      {children}
    </WebStorageOnboardingContext.Provider>
  );
}

export function WebStorageOnboardingProvider({ children }: Readonly<{ children: ReactNode }>) {
  const auth = useAuth();
  const { getAccessToken } = useAccessToken();
  const getAccessTokenRef = useRef(getAccessToken);
  getAccessTokenRef.current = getAccessToken;
  const freshAccessToken = useCallback(() => getAccessTokenRef.current(), []);

  if (auth.user === null) {
    return (
      <WebStorageOnboardingContext.Provider value={null}>
        {children}
      </WebStorageOnboardingContext.Provider>
    );
  }

  return (
    <StorageIdentityBoundary key={auth.user.id} getAccessToken={freshAccessToken}>
      {children}
    </StorageIdentityBoundary>
  );
}

export const useWebStorageOnboarding = (): WebStorageOnboardingContextValue => {
  const client = useContext(WebStorageOnboardingContext);
  if (client === null) {
    throw new Error(
      "useWebStorageOnboarding must be used within an authenticated WebStorageOnboardingProvider.",
    );
  }
  return client;
};
