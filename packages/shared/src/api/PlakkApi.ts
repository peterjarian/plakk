import * as Context from "effect/Context";
import * as Schema from "effect/Schema";
import * as Rpc from "effect/unstable/rpc/Rpc";
import * as RpcGroup from "effect/unstable/rpc/RpcGroup";
import * as RpcMiddleware from "effect/unstable/rpc/RpcMiddleware";

import { SnippetKindLiteral, StorageProviderLiteral, type User } from "../index.ts";
import { RpcError } from "./RpcError.ts";

export const AccountBlockedReasonSchema = Schema.Literals(["billing", "storage"] as const);

export type AccountBlockedReason = typeof AccountBlockedReasonSchema.Type;

export const AccountStatusSchema = Schema.Struct({
  canSync: Schema.Boolean,
  storageProvider: Schema.NullOr(StorageProviderLiteral),
  blockedReasons: Schema.Array(AccountBlockedReasonSchema),
});

export type AccountStatus = typeof AccountStatusSchema.Type;

export const PipeConnectionStatusSchema = Schema.Literals([
  "CONNECTED",
  "NEEDS_REAUTHORIZATION",
  "NOT_CONNECTED",
] as const);

export type PipeConnectionStatus = typeof PipeConnectionStatusSchema.Type;

export const PipeConnectionSchema = Schema.Struct({
  storageProvider: StorageProviderLiteral,
  status: PipeConnectionStatusSchema,
});

export type PipeConnection = typeof PipeConnectionSchema.Type;

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
  kind: SnippetKindLiteral,
  title: Schema.String,
  fileName: Schema.String,
  byteSize: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  contentType: Schema.NullOr(Schema.String),
  storageProvider: Schema.NullOr(StorageProviderLiteral),
  createdAt: Schema.String,
  updatedAt: Schema.String,
});

export type ApiSnippet = typeof ApiSnippetSchema.Type;

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
  Rpc.make("PrepareStoredSnippetUpload", {
    payload: {
      snippetId: SnippetIdSchema,
      storageProvider: StorageProviderLiteral,
      fileName: Schema.String,
      byteSize: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
      contentType: Schema.NullOr(Schema.String),
    },
    success: PreparedStorageUploadSchema,
    error: RpcError,
  }),
);

export const SnippetRpcs = RpcGroup.make(
  Rpc.make("ListSnippets", {
    payload: {
      limit: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 100 })),
    },
    success: Schema.Struct({
      items: Schema.Array(ApiSnippetSchema),
    }),
    error: RpcError,
  }),
  Rpc.make("CreateTextSnippet", {
    payload: { id: SnippetIdSchema, text: Schema.String },
    success: ApiSnippetSchema,
    error: RpcError,
  }),
  Rpc.make("CreateStoredSnippet", {
    payload: {
      id: SnippetIdSchema,
      kind: Schema.Literals(["FILE", "IMAGE"] as const),
      title: Schema.String,
      fileName: Schema.String,
      byteSize: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
      contentType: Schema.NullOr(Schema.String),
      storageProvider: StorageProviderLiteral,
      storageObjectId: Schema.String,
    },
    success: ApiSnippetSchema,
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
