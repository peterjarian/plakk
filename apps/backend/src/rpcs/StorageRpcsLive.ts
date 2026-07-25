import type { StorageProvider as StorageProviderName } from "@plakk/shared";
import { CurrentUser, StorageRpcs, type StorageProviderStatus } from "@plakk/shared/PlakkApi";
import { RpcError } from "@plakk/shared/RpcError";
import * as Config from "effect/Config";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
import { HttpClient, HttpClientRequest, HttpClientResponse } from "effect/unstable/http";

import { getProviderSlug, StorageProvider } from "../storage/StorageProvider.ts";

const WORKOS_BASE_URL = "https://api.workos.com";

const WorkosAuthorizeResponseSchema = Schema.Struct({ url: Schema.String });
const WorkosConnectedAccountSchema = Schema.Struct({
  state: Schema.Literals(["connected", "needs_reauthorization"] as const),
});

const getConnectedAccountUrl = (provider: StorageProviderName, workosUserId: string) =>
  `${WORKOS_BASE_URL}/user_management/users/${encodeURIComponent(workosUserId)}/connected_accounts/${encodeURIComponent(getProviderSlug(provider))}`;

export const StorageRpcsLive = StorageRpcs.of({
  BeginStorageProviderLink: Effect.fn("rpc.BeginStorageProviderLink")(function* (input) {
    return yield* Effect.gen(function* () {
      const apiKey = yield* Config.redacted("WORKOS_API_KEY").pipe(Effect.orDie);
      const currentUser = yield* CurrentUser;
      const request = yield* HttpClientRequest.post(
        `${WORKOS_BASE_URL}/data-integrations/${encodeURIComponent(getProviderSlug(input.storageProvider))}/authorize`,
      ).pipe(
        HttpClientRequest.bearerToken(Redacted.value(apiKey)),
        HttpClientRequest.setHeader("Content-Type", "application/json"),
        HttpClientRequest.bodyJson({ user_id: currentUser.id }),
        Effect.orDie,
      );
      const response = yield* HttpClient.execute(request).pipe(Effect.orDie);

      if (response.status < 200 || response.status >= 300) {
        yield* Effect.logError("WorkOS Pipes authorize failed", { status: response.status });
        return yield* Effect.die(new Error("WorkOS Pipes authorize failed"));
      }

      return yield* HttpClientResponse.schemaBodyJson(WorkosAuthorizeResponseSchema)(response).pipe(
        Effect.orDie,
      );
    }).pipe(Effect.annotateSpans({ storageProvider: input.storageProvider }));
  }),
  GetStorageProviderStatus: Effect.fn("rpc.GetStorageProviderStatus")(function* (input) {
    return yield* Effect.gen(function* () {
      const apiKey = yield* Config.redacted("WORKOS_API_KEY").pipe(Effect.orDie);
      const currentUser = yield* CurrentUser;
      const response = yield* HttpClient.get(
        getConnectedAccountUrl(input.storageProvider, currentUser.id),
        {
          headers: { Authorization: `Bearer ${Redacted.value(apiKey)}` },
        },
      ).pipe(Effect.orDie);

      if (response.status === 404) {
        return {
          storageProvider: input.storageProvider,
          status: "NOT_CONNECTED",
          externalDestinationUrl: null,
        } satisfies StorageProviderStatus;
      }

      if (response.status < 200 || response.status >= 300) {
        yield* Effect.logError("WorkOS Pipes status failed", { status: response.status });
        return yield* Effect.die(new Error("WorkOS Pipes status failed"));
      }

      const account = yield* HttpClientResponse.schemaBodyJson(WorkosConnectedAccountSchema)(
        response,
      ).pipe(Effect.orDie);
      if (account.state === "connected") {
        const storage = yield* StorageProvider;
        return yield* storage
          .getDestinationUrl({
            storageProvider: input.storageProvider,
            workosUserId: currentUser.id,
          })
          .pipe(
            Effect.map(
              (externalDestinationUrl) =>
                ({
                  storageProvider: input.storageProvider,
                  status: "CONNECTED",
                  externalDestinationUrl,
                }) satisfies StorageProviderStatus,
            ),
            Effect.catchTags({
              StorageNeedsReauthorizationError: () =>
                Effect.succeed({
                  storageProvider: input.storageProvider,
                  status: "NEEDS_REAUTHORIZATION",
                  externalDestinationUrl: null,
                } satisfies StorageProviderStatus),
              StorageNotConnectedError: () =>
                Effect.succeed({
                  storageProvider: input.storageProvider,
                  status: "NOT_CONNECTED",
                  externalDestinationUrl: null,
                } satisfies StorageProviderStatus),
              StorageCredentialsError: (error) =>
                Effect.fail(
                  new RpcError({ code: "INTERNAL_SERVER_ERROR", message: error.message }),
                ),
              StorageProviderError: (error) =>
                Effect.fail(
                  new RpcError({
                    code: "INTERNAL_SERVER_ERROR",
                    message: `${error.storageProvider}: ${error.message}`,
                  }),
                ),
            }),
          );
      }

      return {
        storageProvider: input.storageProvider,
        status: "NEEDS_REAUTHORIZATION",
        externalDestinationUrl: null,
      } satisfies StorageProviderStatus;
    }).pipe(Effect.annotateSpans({ storageProvider: input.storageProvider }));
  }),
  UnlinkStorageProvider: Effect.fn("rpc.UnlinkStorageProvider")(function* (input) {
    return yield* Effect.gen(function* () {
      const apiKey = yield* Config.redacted("WORKOS_API_KEY").pipe(Effect.orDie);
      const currentUser = yield* CurrentUser;
      const response = yield* HttpClient.del(
        getConnectedAccountUrl(input.storageProvider, currentUser.id),
        {
          headers: { Authorization: `Bearer ${Redacted.value(apiKey)}` },
        },
      ).pipe(Effect.orDie);

      if (response.status === 404 || (response.status >= 200 && response.status < 300)) return;

      yield* Effect.logError("WorkOS Pipes disconnect failed", { status: response.status });
      return yield* Effect.die(new Error("WorkOS Pipes disconnect failed"));
    }).pipe(Effect.annotateSpans({ storageProvider: input.storageProvider }));
  }),
});
