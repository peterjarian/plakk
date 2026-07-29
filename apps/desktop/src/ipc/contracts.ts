import {
  ClientSnapshotSchema,
  FreeUpSpaceResultSchema,
  SnippetSchema,
} from "@plakk/client-runtime";
import { PrepareSnippetUploadPayloadSchema, SnippetIdSchema } from "@plakk/shared/PlakkApi";
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
    sourceId: Schema.String,
    width: Schema.Number,
    height: Schema.Number,
  }),
  Schema.Struct({
    type: Schema.Literal("file"),
    name: Schema.String,
    sourceId: Schema.String,
    extension: Schema.String,
    size: Schema.optionalKey(Schema.Number),
  }),
  Schema.Struct({
    type: Schema.Literal("empty"),
  }),
]);

export type ClipboardContent = typeof ClipboardContentSchema.Type;

export const AppearancePreferenceSchema = Schema.Literals(["light", "dark", "system"] as const);

export type AppearancePreference = typeof AppearancePreferenceSchema.Type;

export const AppearanceStateSchema = Schema.Struct({
  preference: AppearancePreferenceSchema,
  effective: Schema.Literals(["light", "dark"] as const),
});

export type AppearanceState = typeof AppearanceStateSchema.Type;

export const UserConfigSchema = Schema.Struct({
  appearance: AppearancePreferenceSchema,
  showExternalLinkWarning: Schema.Boolean,
  toolbarWidgetEnabled: Schema.Boolean,
});

export type UserConfig = typeof UserConfigSchema.Type;

export const UserConfigPatchSchema = Schema.Struct({
  showExternalLinkWarning: Schema.optionalKey(Schema.Boolean),
  toolbarWidgetEnabled: Schema.optionalKey(Schema.Boolean),
});

export type UserConfigPatch = typeof UserConfigPatchSchema.Type;

export const TrayDroppedItemSchema = Schema.Union([
  Schema.Struct({
    type: Schema.Literal("files"),
    files: Schema.Array(
      Schema.Struct({ sourceId: Schema.String, name: Schema.String, size: Schema.Number }),
    ),
  }),
  Schema.Struct({
    type: Schema.Literal("text"),
    text: Schema.String,
  }),
]);

export type TrayDroppedItem = typeof TrayDroppedItemSchema.Type;

const SnippetIngestBaseSchema = PrepareSnippetUploadPayloadSchema.fields;

export const SnippetIngestPayloadSchema = Schema.Union([
  Schema.Struct({ ...SnippetIngestBaseSchema, filePath: Schema.String }),
  Schema.Struct({ ...SnippetIngestBaseSchema, sourceId: Schema.String }),
  Schema.Struct({ ...SnippetIngestBaseSchema, bytes: Schema.Uint8Array }),
]);

export type SnippetIngestPayload = typeof SnippetIngestPayloadSchema.Type;
export type ResolvedSnippetIngestPayload = Exclude<
  SnippetIngestPayload,
  { readonly sourceId: string }
>;

export const DesktopSnippetSchema = Schema.Struct({
  snippet: SnippetSchema,
  localTextPreview: Schema.NullOr(Schema.String),
});

export type DesktopSnippet = typeof DesktopSnippetSchema.Type;

const ClientSnapshotFields = ClientSnapshotSchema.fields;

export const LocalStateSchema = Schema.Struct({
  revision: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  user: Schema.NullOr(ClientSnapshotFields.user),
  capability: ClientSnapshotFields.capability,
  syncStatus: Schema.NullOr(ClientSnapshotFields.syncStatus),
  storageUsageBytes: ClientSnapshotFields.storageUsageBytes,
  snippets: Schema.Array(DesktopSnippetSchema),
});

export type LocalState = typeof LocalStateSchema.Type;

export const StorageFreeUpResultSchema = FreeUpSpaceResultSchema;

export type StorageFreeUpResult = typeof StorageFreeUpResultSchema.Type;

export const ipcMethods = {
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
  appearanceGet: method({
    channel: "appearance:get",
    payload: Schema.Void,
    result: AppearanceStateSchema,
  }),
  appearanceSet: method({
    channel: "appearance:set",
    payload: AppearancePreferenceSchema,
    result: AppearanceStateSchema,
  }),
  localStateGet: method({
    channel: "local-state:get",
    payload: Schema.Void,
    result: LocalStateSchema,
  }),
  openExternal: method({
    channel: "open-external",
    payload: Schema.String,
    result: Schema.Void,
  }),
  snippetIngest: method({
    channel: "snippet:ingest",
    payload: SnippetIngestPayloadSchema,
    result: Schema.Void,
  }),
  snippetDiscard: method({
    channel: "snippet:discard",
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
  snippetDownload: method({
    channel: "snippet:download",
    payload: SnippetIdSchema,
    result: Schema.Void,
  }),
  storageFreeUp: method({
    channel: "storage:free-up",
    payload: Schema.Void,
    result: StorageFreeUpResultSchema,
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
      Schema.Struct({ sourceId: Schema.String, name: Schema.String, size: Schema.Number }),
    ),
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
  appearanceChanged: event({
    channel: "appearance:changed",
    payload: AppearanceStateSchema,
  }),
  authError: event({
    channel: "auth:error",
    payload: AuthErrorSchema,
  }),
  localStateChanged: event({
    channel: "local-state:changed",
    payload: LocalStateSchema,
  }),
  clipboardPaste: event({
    channel: "clipboard:paste",
    payload: ClipboardContentSchema,
  }),
  trayDroppedItem: event({
    channel: "tray:dropped-item",
    payload: TrayDroppedItemSchema,
  }),
  navigate: event({
    channel: "navigation:requested",
    payload: Schema.Literals(["home", "settings"] as const),
  }),
} as const;
