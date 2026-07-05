import { Layer, ManagedRuntime } from "effect";
import { AuthService } from "./auth/AuthService.js";
import { UserConfigStore } from "./UserConfigStore.js";

const MainLayer = Layer.mergeAll(UserConfigStore.Live, AuthService.layer);

export const runtime = ManagedRuntime.make(MainLayer);

export const runEffect = runtime.runPromise;
