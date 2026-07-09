import { UserSchema } from "@plakk/shared";
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
    width: Schema.Number,
    height: Schema.Number,
  }),
  Schema.Struct({
    type: Schema.Literal("file"),
    name: Schema.String,
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
    paths: Schema.Array(Schema.String),
  }),
  Schema.Struct({
    type: Schema.Literal("text"),
    text: Schema.String,
  }),
]);

export type TrayDroppedItem = typeof TrayDroppedItemSchema.Type;

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
} as const;
