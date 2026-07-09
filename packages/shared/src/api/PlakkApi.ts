import * as Schema from "effect/Schema";
import * as Rpc from "effect/unstable/rpc/Rpc";
import * as RpcGroup from "effect/unstable/rpc/RpcGroup";
import * as RpcMiddleware from "effect/unstable/rpc/RpcMiddleware";

import { SnippetKindLiteral, StorageProviderLiteral } from "../index.ts";
import { RpcError } from "./RpcError.ts";

export const AccountBlockedReasonSchema = Schema.Literals(["billing", "storage"] as const);

export type AccountBlockedReason = typeof AccountBlockedReasonSchema.Type;

export const AccountStatusSchema = Schema.Struct({
  canSync: Schema.Boolean,
  storageProvider: Schema.NullOr(StorageProviderLiteral),
  blockedReasons: Schema.Array(AccountBlockedReasonSchema),
});

export type AccountStatus = typeof AccountStatusSchema.Type;

export const SnippetIdSchema = Schema.String.check(Schema.isUUID());

export const ApiSnippetSchema = Schema.Struct({
  id: SnippetIdSchema,
  kind: SnippetKindLiteral,
  title: Schema.String,
  fileName: Schema.String,
  byteSize: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  contentType: Schema.NullOr(Schema.String),
  storageProvider: StorageProviderLiteral,
  createdAt: Schema.String,
  updatedAt: Schema.String,
});

export type ApiSnippet = typeof ApiSnippetSchema.Type;

export class InternalServerErrorMiddleware extends RpcMiddleware.Service<InternalServerErrorMiddleware>()(
  "InternalServerErrorMiddleware",
  { error: RpcError },
) {}

export const PlakkApi = RpcGroup.make(
  Rpc.make("Ping", {
    success: Schema.Struct({ ok: Schema.Boolean }),
    error: RpcError,
  }),
  Rpc.make("GetAccountStatus", {
    success: AccountStatusSchema,
    error: RpcError,
  }),
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
    },
    success: ApiSnippetSchema,
    error: RpcError,
  }),
  Rpc.make("DeleteSnippet", {
    payload: { id: SnippetIdSchema },
    success: Schema.Void,
    error: RpcError,
  }),
).middleware(InternalServerErrorMiddleware);
