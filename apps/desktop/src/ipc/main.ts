import { ipcMain, type IpcMainInvokeEvent, type WebContents } from "electron";
import { Cause, Data, Effect, ManagedRuntime, Option, Schema } from "effect";
import type {
  IpcEvent,
  IpcEventPayload,
  IpcMethod,
  IpcPayload,
  IpcResult,
  IpcSchema,
} from "./contracts.ts";

export class IpcHandlerError extends Data.TaggedError("IpcHandlerError")<{
  readonly cause: unknown;
  readonly message: string;
}> {}

const genericIpcError = "Plakk couldn’t complete this action. Try again.";

export function makeHandle<R, ER>(runtime: ManagedRuntime.ManagedRuntime<R, ER>) {
  return function handle<T extends IpcMethod<IpcSchema, IpcSchema>>(
    method: T,
    handler: (
      payload: IpcPayload<T>,
      event: IpcMainInvokeEvent,
    ) => Effect.Effect<IpcResult<T>, IpcHandlerError, R>,
  ) {
    const decodePayload = Schema.decodeUnknownEffect(method.payload);
    const encodeResult = Schema.encodeUnknownEffect(method.result);

    ipcMain.handle(method.channel, (event, raw: unknown) =>
      runtime.runPromise(
        decodePayload(raw).pipe(
          Effect.flatMap((payload) => handler(payload, event)),
          Effect.flatMap(encodeResult),
          Effect.catchCause((cause) => {
            const failure = Option.getOrUndefined(Cause.findErrorOption(cause));
            const message = failure instanceof IpcHandlerError ? failure.message : genericIpcError;
            return Effect.logError("IPC handler failed", { channel: method.channel, cause }).pipe(
              Effect.andThen(Effect.fail(new Error(message))),
            );
          }),
          Effect.withSpan("desktop.ipc.invoke", {
            attributes: { channel: method.channel },
          }),
        ),
      ),
    );
  };
}

export function send<T extends IpcEvent<IpcSchema>>(
  webContents: WebContents,
  event: T,
  payload: IpcEventPayload<T>,
) {
  const encodePayload = Schema.encodeUnknownSync(event.payload);
  webContents.send(event.channel, encodePayload(payload));
}
