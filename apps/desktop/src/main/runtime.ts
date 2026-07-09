import { Layer, ManagedRuntime } from "effect";
import { AuthService } from "./auth/AuthService.ts";
import { AuthStore } from "./auth/AuthStore.ts";
import { UserConfigStore } from "./UserConfigStore.ts";

const MainLayer = Layer.mergeAll(
  UserConfigStore.Live,
  AuthService.layer.pipe(Layer.provideMerge(AuthStore.Live)),
);

export const runtime = ManagedRuntime.make(MainLayer);

export const runEffect = runtime.runPromise;
