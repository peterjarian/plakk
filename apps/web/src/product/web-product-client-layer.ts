import { PlakkApi } from "@plakk/shared/PlakkApi";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { FetchHttpClient } from "effect/unstable/http";
import { RpcClient, RpcSerialization } from "effect/unstable/rpc";

import {
  AccountProductReader,
  readAuthenticatedProduct,
  watchAuthenticatedInvalidations,
} from "./product-reader.ts";
import {
  beginStorageProviderLink,
  readStorageOnboarding,
  StorageOnboardingClient,
} from "./storage-onboarding-client.ts";

export const makeWebProductClientLayer = (options: {
  readonly getAccessToken: () => Promise<string | undefined>;
  readonly rpcUrl: string;
}): Layer.Layer<AccountProductReader | StorageOnboardingClient> => {
  const protocolLayer = RpcClient.layerProtocolHttp({ url: options.rpcUrl }).pipe(
    Layer.provideMerge(FetchHttpClient.layer),
    Layer.provideMerge(RpcSerialization.layerNdjson),
  );

  return Layer.effectContext(
    RpcClient.make(PlakkApi).pipe(
      Effect.map((rpc) =>
        Context.make(
          AccountProductReader,
          AccountProductReader.of({
            invalidations: watchAuthenticatedInvalidations(rpc, options.getAccessToken),
            read: readAuthenticatedProduct(rpc, options.getAccessToken),
          }),
        ).pipe(
          Context.add(
            StorageOnboardingClient,
            StorageOnboardingClient.of({
              begin: (storageProvider, origin) =>
                beginStorageProviderLink(rpc, options.getAccessToken, storageProvider, origin),
              read: (providerHint) =>
                readStorageOnboarding(rpc, options.getAccessToken, providerHint),
            }),
          ),
        ),
      ),
      Effect.provide(protocolLayer),
    ),
  );
};
