import { PlakkApi } from "@plakk/shared/PlakkApi";
import type { BrowserTelemetryOperation } from "@plakk/shared/BrowserTelemetry";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { FetchHttpClient } from "effect/unstable/http";
import { RpcClient, RpcSerialization } from "effect/unstable/rpc";

import {
  AccountProductReader,
  authenticatedRpcOptions,
  readAuthenticatedProduct,
  watchAuthenticatedInvalidations,
} from "./product-reader.ts";
import { beginBillingCheckout, BillingClient, openBillingPortal } from "./billing-client.ts";
import {
  beginStorageProviderLink,
  readStorageOnboarding,
  StorageOnboardingClient,
} from "./storage-onboarding-client.ts";
import {
  beginStorageCleanup,
  readStorageManagement,
  reauthorizeStorageProvider,
  retryStorageCleanup,
  StorageManagementClient,
} from "./storage-management-client.ts";
import { WebSnippetActionRemote } from "./snippet-actions.ts";
import { WebSnippetUploadRemote } from "./snippet-upload.ts";
import {
  makeBrowserTelemetry,
  makeBrowserTelemetryExporter,
  type ObservedRpcOptions,
} from "./browser-telemetry.ts";

export const resolveBrowserTelemetryProxyUrl = (rpcUrl: string): string => {
  const url = new URL(rpcUrl);
  if (url.pathname !== "/api/rpc" || url.search !== "" || url.hash !== "") {
    throw new Error("The product RPC URL must be the canonical /api/rpc endpoint.");
  }
  return `${url.origin}/api/telemetry/v1/traces`;
};

export const resolveBrowserTelemetryRelease = (
  configuredRelease: string | undefined,
  localDevelopment: boolean,
): string => {
  const release = configuredRelease?.trim();
  if (release !== undefined && /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(release)) {
    return release;
  }
  if (localDevelopment && (release === undefined || release === "")) return "development";
  throw new Error("VITE_PLAKK_RELEASE must be a bounded release identifier.");
};

export const makeWebProductClientLayer = (options: {
  readonly getAccessToken: () => Promise<string | undefined>;
  readonly release: string;
  readonly rpcUrl: string;
}): Layer.Layer<
  | AccountProductReader
  | BillingClient
  | StorageManagementClient
  | StorageOnboardingClient
  | WebSnippetActionRemote
  | WebSnippetUploadRemote
> => {
  const protocolLayer = RpcClient.layerProtocolHttp({ url: options.rpcUrl }).pipe(
    Layer.provideMerge(FetchHttpClient.layer),
    Layer.provideMerge(RpcSerialization.layerNdjson),
  );

  return Layer.effectContext(
    RpcClient.make(PlakkApi).pipe(
      Effect.map((rpc) => {
        const telemetry = makeBrowserTelemetry({
          exporter: makeBrowserTelemetryExporter(resolveBrowserTelemetryProxyUrl(options.rpcUrl)),
          release: options.release,
        });
        const observeAuthenticatedRpc = <A, E, R>(
          operation: BrowserTelemetryOperation,
          invoke: (requestOptions: ObservedRpcOptions) => Effect.Effect<A, E, R>,
        ) =>
          authenticatedRpcOptions(options.getAccessToken).pipe(
            Effect.flatMap((requestOptions) =>
              telemetry.observeRpc(operation, requestOptions, invoke),
            ),
          );

        return Context.make(
          AccountProductReader,
          AccountProductReader.of({
            invalidations: watchAuthenticatedInvalidations(rpc, options.getAccessToken),
            read: readAuthenticatedProduct(rpc, options.getAccessToken, telemetry),
          }),
        ).pipe(
          Context.add(
            BillingClient,
            BillingClient.of({
              beginCheckout: (plan) =>
                beginBillingCheckout(rpc, options.getAccessToken, plan, telemetry),
              openPortal: openBillingPortal(rpc, options.getAccessToken, telemetry),
            }),
          ),
          Context.add(
            StorageManagementClient,
            StorageManagementClient.of({
              beginCleanup: (action, storageProvider, expectedSnippetCount) =>
                beginStorageCleanup(
                  rpc,
                  options.getAccessToken,
                  action,
                  storageProvider,
                  expectedSnippetCount,
                  telemetry,
                ),
              read: readStorageManagement(rpc, options.getAccessToken, telemetry),
              reauthorize: (storageProvider) =>
                reauthorizeStorageProvider(rpc, options.getAccessToken, storageProvider, telemetry),
              retryCleanup: (storageProvider) =>
                retryStorageCleanup(rpc, options.getAccessToken, storageProvider, telemetry),
            }),
          ),
          Context.add(
            StorageOnboardingClient,
            StorageOnboardingClient.of({
              begin: (storageProvider, origin) =>
                beginStorageProviderLink(
                  rpc,
                  options.getAccessToken,
                  storageProvider,
                  origin,
                  telemetry,
                ),
              read: (providerHint, consumeAuthorization) =>
                readStorageOnboarding(
                  rpc,
                  options.getAccessToken,
                  providerHint,
                  consumeAuthorization,
                  telemetry,
                ),
            }),
          ),
          Context.add(
            WebSnippetActionRemote,
            WebSnippetActionRemote.of({
              delete: (id) =>
                observeAuthenticatedRpc("snippet.delete", (tracedOptions) =>
                  rpc.DeleteSnippet({ id }, tracedOptions),
                ),
              prepareDownload: (id) =>
                observeAuthenticatedRpc("snippet.prepare-download", (tracedOptions) =>
                  rpc.PrepareSnippetDownload({ id }, tracedOptions),
                ),
              read: (id) =>
                observeAuthenticatedRpc("snippet.read-content", (tracedOptions) =>
                  rpc.GetSnippetContent({ id }, tracedOptions),
                ),
            }),
          ),
          Context.add(
            WebSnippetUploadRemote,
            WebSnippetUploadRemote.of({
              prepare: (input) =>
                observeAuthenticatedRpc("snippet.prepare-upload", (tracedOptions) =>
                  rpc.PrepareSnippetUpload(input, tracedOptions),
                ),
              publish: (input) =>
                observeAuthenticatedRpc("snippet.publish", (tracedOptions) =>
                  rpc.PublishSnippet(input, tracedOptions),
                ),
            }),
          ),
        );
      }),
      Effect.provide(protocolLayer),
    ),
  );
};
