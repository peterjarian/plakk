import { and, Drizzle, eq, type DrizzleService } from "@plakk/db";
import { snippets } from "@plakk/db/schema";
import { STORAGE_PROVIDERS, type StorageProvider } from "@plakk/shared";
import {
  AccountRpcs,
  CurrentUser,
  HealthRpcs,
  PlakkApi,
  SnippetRpcs,
  StorageRpcs,
  type AccountStatus,
  type PipeConnection,
} from "@plakk/shared/PlakkApi";
import { RpcError } from "@plakk/shared/RpcError";
import * as Config from "effect/Config";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
import { HttpClient, HttpClientRequest, HttpClientResponse } from "effect/unstable/http";

import { StorageProviderService } from "./storage/StorageProvider.ts";
import { getProviderSlug } from "./storage/getProviderSlug.ts";
import { mapStorageErrorsToRpc } from "./storage/mapStorageErrorsToRpc.ts";
import { getSnippetSnapshot } from "./snippets/snippetSnapshots.ts";
import { SnippetDeletion } from "./snippets/SnippetDeletion.ts";
import { SnippetUploads } from "./snippets/SnippetUploads.ts";

const DEFAULT_STORAGE_PROVIDER = "GOOGLE_DRIVE" as const;
const WORKOS_BASE_URL = "https://api.workos.com";

const isStorageProvider = (value: string): value is StorageProvider =>
  STORAGE_PROVIDERS.includes(value as StorageProvider);

const WorkosAuthorizeResponseSchema = Schema.Struct({ url: Schema.String });
const WorkosConnectedAccountSchema = Schema.Struct({
  state: Schema.Literals(["connected", "needs_reauthorization"] as const),
});

export const prepareSnippetDownload = Effect.fn(
  "@plakk/web/api/PlakkApiLive.prepareSnippetDownload",
)(function* (
  drizzle: DrizzleService,
  storage: StorageProviderService["Service"],
  workosUserId: string,
  snippetId: string,
) {
  const [snippet] = yield* drizzle.db
    .select()
    .from(snippets)
    .where(and(eq(snippets.id, snippetId), eq(snippets.ownerWorkosUserId, workosUserId)))
    .limit(1)
    .pipe(Effect.orDie);

  if (snippet === undefined) {
    return yield* new RpcError({ code: "NOT_FOUND", message: "Uploaded snippet was not found." });
  }

  const download = yield* storage
    .getDownloadTarget({
      storageProvider: snippet.storageProvider,
      storageObjectId: snippet.storageObjectId,
      workosUserId,
    })
    .pipe(mapStorageErrorsToRpc);

  return {
    storageProvider: snippet.storageProvider,
    fileName: snippet.fileName,
    byteSize: snippet.byteSize,
    download,
  };
});

const getConnectedAccountUrl = (provider: StorageProvider, workosUserId: string) =>
  `${WORKOS_BASE_URL}/user_management/users/${encodeURIComponent(workosUserId)}/connected_accounts/${encodeURIComponent(getProviderSlug(provider))}`;

const HealthLive = HealthRpcs.of({
  Ping: () =>
    Effect.succeed({ ok: true }).pipe(
      Effect.tap(() => Effect.logInfo("Ping")),
      Effect.withSpan("rpc.Ping"),
    ),
});

const AccountLive = AccountRpcs.of({
  GetAccountStatus: Effect.fn("rpc.GetAccountStatus")(function* () {
    const currentUser = yield* CurrentUser;
    const configuredProvider = yield* Config.string("PLAKK_STORAGE_PROVIDER").pipe(
      Effect.orElseSucceed(() => DEFAULT_STORAGE_PROVIDER),
    );
    if (!isStorageProvider(configuredProvider)) {
      return yield* Effect.die(new Error("PLAKK_STORAGE_PROVIDER is invalid."));
    }
    const accountStatus: AccountStatus = {
      canSync: true,
      storageProvider: configuredProvider,
      blockedReasons: [],
    };
    yield* Effect.logInfo("Returning account status", {
      storageProvider: configuredProvider,
      workosUserId: currentUser.id,
    });
    return accountStatus;
  }),
});

const StorageLive = StorageRpcs.of({
  GetPipeConnectionUrl: Effect.fn("rpc.GetPipeConnectionUrl")(function* (input) {
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
  GetPipeConnectionStatus: Effect.fn("rpc.GetPipeConnectionStatus")(function* (input) {
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
        } satisfies PipeConnection;
      }

      if (response.status < 200 || response.status >= 300) {
        yield* Effect.logError("WorkOS Pipes status failed", { status: response.status });
        return yield* Effect.die(new Error("WorkOS Pipes status failed"));
      }

      const account = yield* HttpClientResponse.schemaBodyJson(WorkosConnectedAccountSchema)(
        response,
      ).pipe(Effect.orDie);
      if (account.state === "connected") {
        const storage = yield* StorageProviderService;
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
                }) satisfies PipeConnection,
            ),
            Effect.catchTags({
              StorageNeedsReauthorizationError: () =>
                Effect.succeed({
                  storageProvider: input.storageProvider,
                  status: "NEEDS_REAUTHORIZATION",
                  externalDestinationUrl: null,
                } satisfies PipeConnection),
              StorageNotConnectedError: () =>
                Effect.succeed({
                  storageProvider: input.storageProvider,
                  status: "NOT_CONNECTED",
                  externalDestinationUrl: null,
                } satisfies PipeConnection),
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
      } satisfies PipeConnection;
    }).pipe(Effect.annotateSpans({ storageProvider: input.storageProvider }));
  }),
  DisconnectPipe: Effect.fn("rpc.DisconnectPipe")(function* (input) {
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

const SnippetsLive = SnippetRpcs.of({
  PrepareSnippetUpload: Effect.fn("rpc.PrepareSnippetUpload")(function* (input) {
    const uploads = yield* SnippetUploads;
    const currentUser = yield* CurrentUser;
    return yield* uploads
      .prepare(currentUser.id, input)
      .pipe(Effect.annotateSpans({ id: input.id }));
  }),
  PublishSnippet: Effect.fn("rpc.PublishSnippet")(function* (input) {
    const uploads = yield* SnippetUploads;
    const currentUser = yield* CurrentUser;
    return yield* uploads
      .publish(currentUser.id, input)
      .pipe(Effect.annotateSpans({ id: input.id }));
  }),
  GetSnippetSnapshot: Effect.fn("rpc.GetSnippetSnapshot")(function* () {
    const drizzle = yield* Drizzle;
    const currentUser = yield* CurrentUser;
    return yield* getSnippetSnapshot(drizzle, currentUser.id);
  }),
  PrepareSnippetDownload: Effect.fn("rpc.PrepareSnippetDownload")(function* (input) {
    return yield* Effect.gen(function* () {
      const drizzle = yield* Drizzle;
      const storage = yield* StorageProviderService;
      const currentUser = yield* CurrentUser;
      return yield* prepareSnippetDownload(drizzle, storage, currentUser.id, input.id);
    }).pipe(Effect.annotateSpans({ id: input.id }));
  }),
  DeleteSnippet: Effect.fn("rpc.DeleteSnippet")(function* (input) {
    return yield* Effect.gen(function* () {
      const deletion = yield* SnippetDeletion;
      const currentUser = yield* CurrentUser;

      yield* Effect.logInfo("Deleting snippet", { id: input.id });
      yield* deletion.delete(currentUser.id, input.id);
    }).pipe(Effect.annotateSpans({ id: input.id }));
  }),
});

export const PlakkApiLive = PlakkApi.toLayer(
  PlakkApi.of({
    ...HealthLive,
    ...AccountLive,
    ...StorageLive,
    ...SnippetsLive,
  }),
);
