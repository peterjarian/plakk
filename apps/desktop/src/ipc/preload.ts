import { ipcRenderer, type IpcRendererEvent } from "electron";
import { Schema } from "effect";
import type {
  IpcEvent,
  IpcEventPayload,
  IpcMethod,
  IpcPayload,
  IpcResult,
  IpcSchema,
} from "./contracts.ts";

export async function invoke<T extends IpcMethod<IpcSchema, IpcSchema>>(
  method: T,
  payload: IpcPayload<T>,
): Promise<IpcResult<T>> {
  const encodePayload = Schema.encodeUnknownPromise(method.payload);
  const decodeResult = Schema.decodeUnknownPromise(method.result);
  return decodeResult(await ipcRenderer.invoke(method.channel, await encodePayload(payload)));
}

export function on<T extends IpcEvent<IpcSchema>>(
  event: T,
  callback: (payload: IpcEventPayload<T>) => void,
) {
  const decodePayload = Schema.decodeUnknownPromise(event.payload);
  const listener = (_event: IpcRendererEvent, raw: unknown) => {
    void decodePayload(raw).then(callback, console.error);
  };

  ipcRenderer.on(event.channel, listener);
  return () => ipcRenderer.off(event.channel, listener);
}
