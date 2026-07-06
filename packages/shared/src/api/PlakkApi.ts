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

export const ApiSnippetSchema = Schema.Struct({
  id: Schema.String,
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
  class Ping extends Rpc.make("Ping", {
    success: Schema.Struct({ ok: Schema.Boolean }),
    error: RpcError,
  }) {},
  class GetAccountStatus extends Rpc.make("GetAccountStatus", {
    success: AccountStatusSchema,
    error: RpcError,
  }) {},
  class ListSnippets extends Rpc.make("ListSnippets", {
    payload: {
      limit: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 100 })),
      cursor: Schema.optionalKey(Schema.String),
    },
    success: Schema.Struct({
      items: Schema.Array(ApiSnippetSchema),
      nextCursor: Schema.NullOr(Schema.String),
    }),
    error: RpcError,
  }) {},
  class CreateTextSnippet extends Rpc.make("CreateTextSnippet", {
    payload: { text: Schema.String },
    success: ApiSnippetSchema,
    error: RpcError,
  }) {},
  class CreateStoredSnippet extends Rpc.make("CreateStoredSnippet", {
    payload: {
      kind: Schema.Literals(["FILE", "IMAGE"] as const),
      title: Schema.String,
      storageProvider: StorageProviderLiteral,
      storageObjectId: Schema.String,
      fileName: Schema.String,
      byteSize: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
      contentType: Schema.NullOr(Schema.String),
    },
    success: ApiSnippetSchema,
    error: RpcError,
  }) {},
  class DeleteSnippet extends Rpc.make("DeleteSnippet", {
    payload: { id: Schema.String },
    success: Schema.Void,
    error: RpcError,
  }) {},
).middleware(InternalServerErrorMiddleware);
