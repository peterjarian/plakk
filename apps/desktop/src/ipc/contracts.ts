import { SnippetUploadStatusLiteral, StorageProviderLiteral, UserSchema } from "@plakk/shared";
import { AccountStatusSchema, SnippetIdSchema } from "@plakk/shared/PlakkApi";
import { Schema } from "effect";

export type IpcSchema = Schema.ConstraintCodec<unknown, unknown, never, never>;

export interface IpcMethod<Payload extends IpcSchema, Result extends IpcSchema> {
  readonly channel: string;
  readonly payload: Payload;
  readonly result: Result;
}

export interface IpcEvent<Payload extends IpcSchema> {
  readonly channel: string;
  readonly payload: Payload;
}

const method = <Payload extends IpcSchema, Result extends IpcSchema>(
  input: IpcMethod<Payload, Result>,
) => input;

const event = <Payload extends IpcSchema>(input: IpcEvent<Payload>) => input;

export type IpcPayload<T extends IpcMethod<IpcSchema, IpcSchema>> = T["payload"]["Type"];
export type IpcResult<T extends IpcMethod<IpcSchema, IpcSchema>> = T["result"]["Type"];
export type IpcEventPayload<T extends IpcEvent<IpcSchema>> = T["payload"]["Type"];

export const AuthStatusSchema = Schema.Struct({
  accessToken: Schema.NullOr(Schema.String),
  user: Schema.NullOr(UserSchema),
});

export type AuthStatus = typeof AuthStatusSchema.Type;

export const AuthErrorSchema = Schema.Struct({
  message: Schema.String,
});

export type AuthError = typeof AuthErrorSchema.Type;

export const ClipboardContentSchema = Schema.Union([
  Schema.Struct({
    type: Schema.Literal("text"),
    text: Schema.String,
  }),
  Schema.Struct({
    type: Schema.Literal("image"),
    dataUrl: Schema.String,
    path: Schema.String,
    width: Schema.Number,
    height: Schema.Number,
  }),
  Schema.Struct({
    type: Schema.Literal("file"),
    name: Schema.String,
    path: Schema.String,
    extension: Schema.String,
    size: Schema.optionalKey(Schema.Number),
  }),
  Schema.Struct({
    type: Schema.Literal("empty"),
  }),
]);

export type ClipboardContent = typeof ClipboardContentSchema.Type;

const UserConfigSchema = Schema.Struct({
  showExternalLinkWarning: Schema.Boolean,
});

export type UserConfig = typeof UserConfigSchema.Type;

export type UserConfigPatch = Partial<UserConfig>;

const UserConfigPatchSchema = Schema.Struct({
  showExternalLinkWarning: Schema.optionalKey(Schema.Boolean),
});

export const TrayDroppedItemSchema = Schema.Union([
  Schema.Struct({
    type: Schema.Literal("files"),
    files: Schema.Array(
      Schema.Struct({ path: Schema.String, name: Schema.String, size: Schema.Number }),
    ),
  }),
  Schema.Struct({
    type: Schema.Literal("text"),
    text: Schema.String,
  }),
]);

export type TrayDroppedItem = typeof TrayDroppedItemSchema.Type;

export const TrayAccountStateSchema = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("loading") }),
  Schema.Struct({ kind: Schema.Literal("failed") }),
  Schema.Struct({ kind: Schema.Literal("resolved"), account: AccountStatusSchema }),
]);

export type TrayAccountState = typeof TrayAccountStateSchema.Type;

const SnippetIngestBaseSchema = {
  id: SnippetIdSchema,
  fileName: Schema.String,
  byteSize: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  mediaType: Schema.NullOr(Schema.String),
  storageProvider: StorageProviderLiteral,
};

export const SnippetIngestPayloadSchema = Schema.Union([
  Schema.Struct({ ...SnippetIngestBaseSchema, filePath: Schema.String }),
  Schema.Struct({ ...SnippetIngestBaseSchema, bytes: Schema.Uint8Array }),
]);

export type SnippetIngestPayload = typeof SnippetIngestPayloadSchema.Type;

const SnippetIngestResultSchema = Schema.Union([
  Schema.Struct({ status: Schema.Literal("ENQUEUED") }),
  Schema.Struct({ status: Schema.Literal("FAILED"), message: Schema.String }),
]);

export const DesktopSnippetLocalStateSchema = Schema.Struct({
  phase: Schema.Literals(["IMPORTING", "QUEUED", "UPLOADING", "FAILED"] as const),
  progress: Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 100 })),
  errorMessage: Schema.NullOr(Schema.String),
  canRetry: Schema.Boolean,
});

export const DesktopSnippetSchema = Schema.Struct({
  id: SnippetIdSchema,
  fileName: Schema.String,
  byteSize: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  storageProvider: StorageProviderLiteral,
  storageObjectId: Schema.NullOr(Schema.String),
  uploadStatus: Schema.NullOr(SnippetUploadStatusLiteral),
  createdAt: Schema.String,
  updatedAt: Schema.String,
  localState: Schema.NullOr(DesktopSnippetLocalStateSchema),
  localTextContent: Schema.NullOr(Schema.String),
  contentAvailable: Schema.Boolean,
});

export type DesktopSnippet = typeof DesktopSnippetSchema.Type;

export const ipcMethods = {
  authGet: method({
    channel: "auth:get",
    payload: Schema.Void,
    result: AuthStatusSchema,
  }),
  authSignIn: method({
    channel: "auth:sign-in",
    payload: Schema.Void,
    result: Schema.Void,
  }),
  authSignOut: method({
    channel: "auth:sign-out",
    payload: Schema.Void,
    result: Schema.Void,
  }),
  openExternal: method({
    channel: "open-external",
    payload: Schema.String,
    result: Schema.Void,
  }),
  snippetIngest: method({
    channel: "snippet:ingest",
    payload: SnippetIngestPayloadSchema,
    result: SnippetIngestResultSchema,
  }),
  snippetDiscard: method({
    channel: "snippet:discard",
    payload: SnippetIdSchema,
    result: Schema.Void,
  }),
  snippetCancel: method({
    channel: "snippet:cancel",
    payload: SnippetIdSchema,
    result: Schema.Void,
  }),
  snippetRetry: method({
    channel: "snippet:retry",
    payload: SnippetIdSchema,
    result: Schema.Void,
  }),
  snippetDelete: method({
    channel: "snippet:delete",
    payload: SnippetIdSchema,
    result: Schema.Void,
  }),
  snippetCopy: method({
    channel: "snippet:copy",
    payload: SnippetIdSchema,
    result: Schema.Void,
  }),
  snippetRead: method({
    channel: "snippet:read",
    payload: SnippetIdSchema,
    result: Schema.Uint8Array,
  }),
  snippetList: method({
    channel: "snippet:list",
    payload: Schema.Void,
    result: Schema.Array(DesktopSnippetSchema),
  }),
  clipboardRead: method({
    channel: "clipboard:read",
    payload: Schema.Void,
    result: ClipboardContentSchema,
  }),
  traySelectFiles: method({
    channel: "tray:select-files",
    payload: Schema.Void,
    result: Schema.Array(
      Schema.Struct({ path: Schema.String, name: Schema.String, size: Schema.Number }),
    ),
  }),
  trayGetAccountState: method({
    channel: "tray:get-account-state",
    payload: Schema.Void,
    result: TrayAccountStateSchema,
  }),
  userConfigGet: method({
    channel: "user-config:get",
    payload: Schema.Void,
    result: UserConfigSchema,
  }),
  userConfigReset: method({
    channel: "user-config:reset",
    payload: Schema.Void,
    result: UserConfigSchema,
  }),
  userConfigSet: method({
    channel: "user-config:set",
    payload: UserConfigPatchSchema,
    result: UserConfigSchema,
  }),
} as const;

export const ipcEvents = {
  authStatusChanged: event({
    channel: "auth:status-changed",
    payload: AuthStatusSchema,
  }),
  authError: event({
    channel: "auth:error",
    payload: AuthErrorSchema,
  }),
  clipboardPaste: event({
    channel: "clipboard:paste",
    payload: ClipboardContentSchema,
  }),
  trayDroppedItem: event({
    channel: "tray:dropped-item",
    payload: TrayDroppedItemSchema,
  }),
  trayAccountStateChanged: event({
    channel: "tray:account-state-changed",
    payload: TrayAccountStateSchema,
  }),
  navigate: event({
    channel: "navigation:requested",
    payload: Schema.Literals(["home", "settings"] as const),
  }),
  snippetReplicaChanged: event({
    channel: "snippet:replica-changed",
    payload: Schema.Array(DesktopSnippetSchema),
  }),
} as const;
