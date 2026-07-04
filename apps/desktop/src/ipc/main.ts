import { ipcMain, type WebContents } from "electron";
import { Schema } from "effect";
import type {
  IpcEvent,
  IpcEventPayload,
  IpcMethod,
  IpcPayload,
  IpcResult,
  IpcSchema,
} from "./contracts.js";

export function handle<T extends IpcMethod<IpcSchema, IpcSchema>>(
  method: T,
  handler: (payload: IpcPayload<T>) => IpcResult<T> | Promise<IpcResult<T>>,
) {
  const decodePayload = Schema.decodeUnknownPromise(method.payload);
  const encodeResult = Schema.encodeUnknownPromise(method.result);

  ipcMain.handle(method.channel, async (_event, raw: unknown) => {
    const payload = await decodePayload(raw);
    return encodeResult(await handler(payload));
  });
}

export function send<T extends IpcEvent<IpcSchema>>(
  webContents: WebContents,
  event: T,
  payload: IpcEventPayload<T>,
) {
  const encodePayload = Schema.encodeUnknownSync(event.payload);
  webContents.send(event.channel, encodePayload(payload));
}
