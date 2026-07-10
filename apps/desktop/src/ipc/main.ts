import { ipcMain, type IpcMainInvokeEvent, type WebContents } from "electron";
import { Schema } from "effect";
import type {
  IpcEvent,
  IpcEventPayload,
  IpcMethod,
  IpcPayload,
  IpcResult,
  IpcSchema,
} from "./contracts.ts";

export function handle<T extends IpcMethod<IpcSchema, IpcSchema>>(
  method: T,
  handler: (
    payload: IpcPayload<T>,
    event: IpcMainInvokeEvent,
  ) => IpcResult<T> | Promise<IpcResult<T>>,
) {
  const decodePayload = Schema.decodeUnknownPromise(method.payload);
  const encodeResult = Schema.encodeUnknownPromise(method.result);

  ipcMain.handle(method.channel, async (event, raw: unknown) => {
    const payload = await decodePayload(raw);
    return encodeResult(await handler(payload, event));
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
