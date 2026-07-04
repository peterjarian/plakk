import { ManagedRuntime } from "effect";
import { UserConfigStore } from "./UserConfigStore.js";

export const runtime = ManagedRuntime.make(UserConfigStore.Live);

export const runEffect = runtime.runPromise;
export const runEffectSync = runtime.runSync;
