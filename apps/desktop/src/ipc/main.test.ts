import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { Effect, Layer, ManagedRuntime, Schema } from "effect";

const electron = vi.hoisted(() => ({
  handle: vi.fn(),
}));

vi.mock("electron", () => ({
  ipcMain: { handle: electron.handle },
}));

import { IpcHandlerError, makeHandle } from "./main.ts";

const method = {
  channel: "test:double",
  payload: Schema.Struct({ value: Schema.Number }),
  result: Schema.Struct({ doubled: Schema.Number }),
} as const;

const runtimes: Array<ManagedRuntime.ManagedRuntime<never, never>> = [];

afterEach(async () => {
  electron.handle.mockReset();
  await Promise.all(runtimes.splice(0).map((runtime) => runtime.dispose()));
});

describe("makeHandle", () => {
  it("decodes parameters and runs an Effect handler with its Electron event", async () => {
    const runtime = ManagedRuntime.make(Layer.empty);
    runtimes.push(runtime);
    const event = { sender: { id: 42 } };
    const handler = vi.fn((payload: { readonly value: number }, receivedEvent: unknown) =>
      Effect.succeed({ doubled: receivedEvent === event ? payload.value * 2 : 0 }),
    );

    makeHandle(runtime)(method, handler);
    const listener = electron.handle.mock.calls[0]?.[1] as (
      event: unknown,
      raw: unknown,
    ) => Promise<unknown>;

    await expect(listener(event, { value: 3 })).resolves.toEqual({ doubled: 6 });
    expect(handler).toHaveBeenCalledWith({ value: 3 }, event);
  });

  it("exposes only explicit handler copy and uses a generic fallback otherwise", async () => {
    const runtime = ManagedRuntime.make(Layer.empty);
    runtimes.push(runtime);
    const handle = makeHandle(runtime);

    handle(method, () =>
      Effect.fail(new IpcHandlerError({ cause: null, message: "Choose another file." })),
    );
    const controlled = electron.handle.mock.calls[0]?.[1] as (
      event: unknown,
      raw: unknown,
    ) => Promise<unknown>;
    await expect(controlled({}, { value: 1 })).rejects.toThrow("Choose another file.");

    handle(method, () => Effect.die(new Error("sensitive implementation detail")));
    const unknown = electron.handle.mock.calls[1]?.[1] as (
      event: unknown,
      raw: unknown,
    ) => Promise<unknown>;
    await expect(unknown({}, { value: 1 })).rejects.toThrow(
      "Plakk couldn’t complete this action. Try again.",
    );
  });
});
