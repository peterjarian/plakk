import { Layer, ManagedRuntime } from "effect";
import { AuthService } from "./auth/AuthService.ts";
import { UserConfigStore } from "./UserConfigStore.ts";

const MainLayer = Layer.mergeAll(UserConfigStore.Live, AuthService.layer);

export const runtime = ManagedRuntime.make(MainLayer);

export const runEffect = runtime.runPromise;
