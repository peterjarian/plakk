import { Schema } from "effect";
import { AuthErrorSchema, AuthStatusSchema } from "../auth.js";
import { ClipboardContentSchema } from "../clipboardContent.js";
import { UserConfigPatchSchema, UserConfigSchema } from "../userConfig.js";

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
} as const;
