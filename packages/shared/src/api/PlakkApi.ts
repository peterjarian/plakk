import * as Context from "effect/Context";
import * as Schema from "effect/Schema";
import * as Rpc from "effect/unstable/rpc/Rpc";
import * as RpcGroup from "effect/unstable/rpc/RpcGroup";
import * as RpcMiddleware from "effect/unstable/rpc/RpcMiddleware";

import { SnippetUploadStatusLiteral, StorageProviderLiteral, type User } from "../index.ts";
import { RpcError } from "./RpcError.ts";

export const AccountBlockedReasonSchema = Schema.Literals(["billing", "storage"] as const);

export type AccountBlockedReason = typeof AccountBlockedReasonSchema.Type;

export const AccountStatusSchema = Schema.Struct({
  canSync: Schema.Boolean,
  storageProvider: Schema.NullOr(StorageProviderLiteral),
  blockedReasons: Schema.Array(AccountBlockedReasonSchema),
});

export type AccountStatus = typeof AccountStatusSchema.Type;

export const accountCanSync = (account: AccountStatus): boolean =>
  account.canSync && account.blockedReasons.length === 0 && account.storageProvider !== null;

export const PipeConnectionStatusSchema = Schema.Literals([
  "CONNECTED",
  "NEEDS_REAUTHORIZATION",
  "NOT_CONNECTED",
] as const);

export type PipeConnectionStatus = typeof PipeConnectionStatusSchema.Type;

export const PipeConnectionSchema = Schema.Union([
  Schema.Struct({
    storageProvider: StorageProviderLiteral,
    status: Schema.Literal("CONNECTED"),
    externalDestinationUrl: Schema.String,
  }),
  Schema.Struct({
    storageProvider: StorageProviderLiteral,
    status: Schema.Literals(["NEEDS_REAUTHORIZATION", "NOT_CONNECTED"] as const),
    externalDestinationUrl: Schema.Null,
  }),
]);

export type PipeConnection = typeof PipeConnectionSchema.Type;

export const accountCanSyncWithConnection = (
  account: AccountStatus,
  connection: PipeConnection | null,
): boolean => accountCanSync(account) && connection?.status === "CONNECTED";

export const PreparedStorageUploadSchema = Schema.Struct({
  storageProvider: StorageProviderLiteral,
  storageObjectId: Schema.NullOr(Schema.String),
  upload: Schema.Struct({
    method: Schema.Literals(["POST", "PUT"] as const),
    url: Schema.String,
    headers: Schema.Array(Schema.Struct({ name: Schema.String, value: Schema.String })),
    strategy: Schema.Union([
      Schema.Struct({ type: Schema.Literal("single_request") }),
      Schema.Struct({
        type: Schema.Literal("byte_range"),
        maxPartByteSize: Schema.Int.check(Schema.isGreaterThan(0)),
        partByteMultiple: Schema.Int.check(Schema.isGreaterThan(0)),
      }),
    ]),
  }),
  expiresAt: Schema.NullOr(Schema.String),
});

export type PreparedStorageUpload = typeof PreparedStorageUploadSchema.Type;

export const SnippetIdSchema = Schema.String.check(Schema.isUUID());

export const ApiSnippetSchema = Schema.Struct({
  id: SnippetIdSchema,
  fileName: Schema.String,
  byteSize: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  storageProvider: StorageProviderLiteral,
  storageObjectId: Schema.NullOr(Schema.String),
  uploadStatus: SnippetUploadStatusLiteral,
  createdAt: Schema.String,
  updatedAt: Schema.String,
});

export type ApiSnippet = typeof ApiSnippetSchema.Type;

export const SnippetChangeCursorSchema = Schema.String;

export const ApiSnippetChangeSchema = Schema.Union([
  Schema.Struct({
    type: Schema.Literal("UPSERT"),
    snippet: ApiSnippetSchema,
  }),
  Schema.Struct({
    type: Schema.Literal("DELETE"),
    snippetId: SnippetIdSchema,
  }),
]);

export type ApiSnippetChange = typeof ApiSnippetChangeSchema.Type;

export const SnippetChangePageSchema = Schema.Union([
  Schema.Struct({
    status: Schema.Literal("OK"),
    changes: Schema.Array(ApiSnippetChangeSchema),
    nextCursor: SnippetChangeCursorSchema,
  }),
  Schema.Struct({ status: Schema.Literal("RESNAPSHOT_REQUIRED") }),
]);

export type SnippetChangePage = typeof SnippetChangePageSchema.Type;

export const SNIPPET_CHANGES_AVAILABLE = "CHANGES_AVAILABLE" as const;
export const SnippetChangeWakeSchema = Schema.Literal(SNIPPET_CHANGES_AVAILABLE);

export const CreateStoredSnippetPayloadSchema = Schema.Struct({
  id: SnippetIdSchema,
  fileName: Schema.String,
  byteSize: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  storageProvider: StorageProviderLiteral,
});

export type CreateStoredSnippetPayload = typeof CreateStoredSnippetPayloadSchema.Type;

export class CurrentUser extends Context.Service<CurrentUser, User>()(
  "@plakk/shared/api/PlakkApi/CurrentUser",
) {}

export class InternalServerErrorMiddleware extends RpcMiddleware.Service<InternalServerErrorMiddleware>()(
  "InternalServerErrorMiddleware",
  { error: RpcError },
) {}

export class AuthMiddleware extends RpcMiddleware.Service<
  AuthMiddleware,
  { provides: CurrentUser }
>()("AuthMiddleware", { error: RpcError }) {}

export const HealthRpcs = RpcGroup.make(
  Rpc.make("Ping", {
    success: Schema.Struct({ ok: Schema.Boolean }),
    error: RpcError,
  }),
);

export const AccountRpcs = RpcGroup.make(
  Rpc.make("GetAccountStatus", {
    success: AccountStatusSchema,
    error: RpcError,
  }),
);

export const StorageRpcs = RpcGroup.make(
  Rpc.make("GetPipeConnectionUrl", {
    payload: { storageProvider: StorageProviderLiteral },
    success: Schema.Struct({ url: Schema.String }),
    error: RpcError,
  }),
  Rpc.make("GetPipeConnectionStatus", {
    payload: { storageProvider: StorageProviderLiteral },
    success: PipeConnectionSchema,
    error: RpcError,
  }),
  Rpc.make("DisconnectPipe", {
    payload: { storageProvider: StorageProviderLiteral },
    success: Schema.Void,
    error: RpcError,
  }),
);

export const SubscribeSnippetChangesRpc = Rpc.make("SubscribeSnippetChanges", {
  success: SnippetChangeWakeSchema,
  error: RpcError,
  stream: true,
});

export const SnippetRpcs = RpcGroup.make(
  Rpc.make("CreateStoredSnippet", {
    payload: CreateStoredSnippetPayloadSchema,
    success: ApiSnippetSchema,
    error: RpcError,
  }),
  Rpc.make("PrepareStoredSnippetUpload", {
    payload: {
      snippetId: SnippetIdSchema,
      mediaType: Schema.NullOr(Schema.String),
    },
    success: PreparedStorageUploadSchema,
    error: RpcError,
  }),
  Rpc.make("GetSnippetSnapshot", {
    success: Schema.Struct({
      items: Schema.Array(ApiSnippetSchema),
      cursor: SnippetChangeCursorSchema,
    }),
    error: RpcError,
  }),
  Rpc.make("PullSnippetChanges", {
    payload: {
      cursor: SnippetChangeCursorSchema,
      limit: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 100 })),
    },
    success: SnippetChangePageSchema,
    error: RpcError,
  }),
  SubscribeSnippetChangesRpc,
  Rpc.make("HeartbeatStoredSnippetUpload", {
    payload: { id: SnippetIdSchema },
    success: Schema.Struct({ expiresAt: Schema.String }),
    error: RpcError,
  }),
  Rpc.make("FailStoredSnippetUpload", {
    payload: { id: SnippetIdSchema },
    success: ApiSnippetSchema,
    error: RpcError,
  }),
  Rpc.make("RetryStoredSnippetUpload", {
    payload: { id: SnippetIdSchema },
    success: ApiSnippetSchema,
    error: RpcError,
  }),
  Rpc.make("CompleteStoredSnippetUpload", {
    payload: { id: SnippetIdSchema, storageObjectId: Schema.String },
    success: ApiSnippetSchema,
    error: RpcError,
  }),
  Rpc.make("PrepareSnippetDownload", {
    payload: { id: SnippetIdSchema },
    success: Schema.Struct({
      storageProvider: StorageProviderLiteral,
      fileName: Schema.String,
      byteSize: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
      download: Schema.Struct({
        url: Schema.String,
        headers: Schema.Array(Schema.Struct({ name: Schema.String, value: Schema.String })),
      }),
    }),
    error: RpcError,
  }),
  Rpc.make("DeleteSnippet", {
    payload: { id: SnippetIdSchema },
    success: Schema.Void,
    error: RpcError,
  }),
);

const ProtectedRpcs = AccountRpcs.merge(StorageRpcs, SnippetRpcs).middleware(AuthMiddleware);

export const PlakkApi = HealthRpcs.merge(ProtectedRpcs).middleware(InternalServerErrorMiddleware);
