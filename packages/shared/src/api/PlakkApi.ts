import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Schema from "effect/Schema";
import * as Rpc from "effect/unstable/rpc/Rpc";
import * as RpcGroup from "effect/unstable/rpc/RpcGroup";
import * as RpcMiddleware from "effect/unstable/rpc/RpcMiddleware";

import { StorageProviderLiteral } from "../StorageProvider.ts";
import { AuthenticatedRpcRequest } from "./AuthenticatedRpcRequest.ts";
import { RpcError } from "./RpcError.ts";

export { AuthenticatedRpcRequest } from "./AuthenticatedRpcRequest.ts";

export const AccountBlockedReasonSchema = Schema.Literals(["billing", "storage"] as const);

export type AccountBlockedReason = typeof AccountBlockedReasonSchema.Type;

export const AccountAccessEntitlementSchema = Schema.Struct({
  status: Schema.Literals(["TRIAL_ACTIVE", "BILLING_RESTRICTED"] as const),
  trialEndsAt: Schema.DateTimeUtcFromString,
});

export type AccountAccessEntitlement = typeof AccountAccessEntitlementSchema.Type;

export const AccountStatusSchema = Schema.Struct({
  accessEntitlement: AccountAccessEntitlementSchema,
  canSync: Schema.Boolean,
  storageProvider: Schema.NullOr(StorageProviderLiteral),
  blockedReasons: Schema.Array(AccountBlockedReasonSchema),
});

export type AccountStatus = typeof AccountStatusSchema.Type;

export const accountTrialExpiryDelayMillis = (
  account: AccountStatus,
  nowMillis: number,
): number | null =>
  account.accessEntitlement.status === "TRIAL_ACTIVE"
    ? Math.max(0, DateTime.toEpochMillis(account.accessEntitlement.trialEndsAt) - nowMillis)
    : null;

export const accountWithBillingRestriction = (account: AccountStatus): AccountStatus => ({
  ...account,
  accessEntitlement: {
    ...account.accessEntitlement,
    status: "BILLING_RESTRICTED",
  },
  blockedReasons: account.blockedReasons.includes("billing")
    ? account.blockedReasons
    : [...account.blockedReasons, "billing"],
  canSync: false,
});

export const accountBillingRestricted = (account: AccountStatus): boolean =>
  account.accessEntitlement.status === "BILLING_RESTRICTED" ||
  account.blockedReasons.includes("billing");

export const accountCanSync = (account: AccountStatus): boolean =>
  account.canSync && account.blockedReasons.length === 0 && account.storageProvider !== null;

export const StorageProviderConnectionStatusSchema = Schema.Literals([
  "CONNECTED",
  "NEEDS_REAUTHORIZATION",
  "NOT_CONNECTED",
] as const);

export type StorageProviderConnectionStatus = typeof StorageProviderConnectionStatusSchema.Type;

export const StorageProviderStatusSchema = Schema.Union([
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

export type StorageProviderStatus = typeof StorageProviderStatusSchema.Type;

export const StorageOnboardingOriginSchema = Schema.Literals(["WEB", "DESKTOP"] as const);

export type StorageOnboardingOrigin = typeof StorageOnboardingOriginSchema.Type;

export const accountCanSyncWithConnection = (
  account: AccountStatus,
  connection: StorageProviderStatus | null,
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
  storageObjectId: Schema.String,
  createdAt: Schema.String,
  updatedAt: Schema.String,
});

export type ApiSnippet = typeof ApiSnippetSchema.Type;

export const SNIPPETS_CHANGED = "SNIPPETS_CHANGED" as const;
export const SNIPPET_INVALIDATION_KEEP_ALIVE = "KEEP_ALIVE" as const;

export const SnippetInvalidationEventSchema = Schema.Literals([
  SNIPPETS_CHANGED,
  SNIPPET_INVALIDATION_KEEP_ALIVE,
] as const);

export type SnippetInvalidationEvent = typeof SnippetInvalidationEventSchema.Type;

export const PrepareSnippetUploadPayloadSchema = Schema.Struct({
  id: SnippetIdSchema,
  fileName: Schema.String,
  byteSize: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  storageProvider: StorageProviderLiteral,
  mediaType: Schema.NullOr(Schema.String),
});

export type PrepareSnippetUploadPayload = typeof PrepareSnippetUploadPayloadSchema.Type;

export const PublishSnippetPayloadSchema = Schema.Struct({
  id: SnippetIdSchema,
  fileName: Schema.String,
  byteSize: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  storageProvider: StorageProviderLiteral,
  storageObjectId: Schema.String,
});

export type PublishSnippetPayload = typeof PublishSnippetPayloadSchema.Type;

export class CurrentUser extends Context.Service<CurrentUser, { readonly id: string }>()(
  "@plakk/shared/api/PlakkApi/CurrentUser",
) {}

export class InternalServerErrorMiddleware extends RpcMiddleware.Service<InternalServerErrorMiddleware>()(
  "InternalServerErrorMiddleware",
  { error: RpcError },
) {}

export class AuthMiddleware extends RpcMiddleware.Service<
  AuthMiddleware,
  { provides: AuthenticatedRpcRequest | CurrentUser }
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
  Rpc.make("BeginStorageProviderLink", {
    payload: {
      storageProvider: StorageProviderLiteral,
      origin: StorageOnboardingOriginSchema,
    },
    success: Schema.Struct({ url: Schema.String }),
    error: RpcError,
  }),
  Rpc.make("GetStorageProviderStatus", {
    payload: { storageProvider: StorageProviderLiteral },
    success: StorageProviderStatusSchema,
    error: RpcError,
  }),
  Rpc.make("UnlinkStorageProvider", {
    payload: { storageProvider: StorageProviderLiteral },
    success: Schema.Void,
    error: RpcError,
  }),
);

export const SnippetRpcs = RpcGroup.make(
  Rpc.make("PrepareSnippetUpload", {
    payload: PrepareSnippetUploadPayloadSchema,
    success: PreparedStorageUploadSchema,
    error: RpcError,
  }),
  Rpc.make("GetSnippetSnapshot", {
    success: Schema.Array(ApiSnippetSchema),
    error: RpcError,
  }),
  Rpc.make("WatchSnippetInvalidations", {
    success: SnippetInvalidationEventSchema,
    error: RpcError,
    stream: true,
  }),
  Rpc.make("PublishSnippet", {
    payload: PublishSnippetPayloadSchema,
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
