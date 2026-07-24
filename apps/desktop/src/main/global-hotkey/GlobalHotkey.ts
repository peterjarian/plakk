import { hasNonModifierKey, normalizeHotkey, parseHotkey, validateHotkey } from "@tanstack/hotkeys";
import { Context, Effect, Layer, Ref, Result, Schema, Semaphore } from "effect";

import type {
  GlobalHotkeyPreferences,
  GlobalHotkeyStatus,
  GlobalHotkeyUpdate,
  UserConfig,
} from "../../ipc/contracts.ts";
import { UserConfigStore, type UserConfigStoreError } from "../UserConfigStore.ts";

export type DesktopPlatform = "mac" | "windows" | "linux";

export interface GlobalHotkeyPlatform {
  readonly register: (accelerator: string, callback: () => void) => boolean;
  readonly unregister: (accelerator: string) => void;
}

type ActiveRegistration = {
  readonly accelerator: string;
  readonly shortcut: string;
};

type RegistrationState = {
  readonly active: ActiveRegistration | null;
  readonly errorMessage: string | null;
  readonly recording: boolean;
};

export class GlobalHotkeyError extends Schema.TaggedErrorClass<GlobalHotkeyError>()(
  "GlobalHotkeyError",
  {
    cause: Schema.Defect(),
    reason: Schema.String,
  },
) {}

export class GlobalHotkey extends Context.Service<
  GlobalHotkey,
  {
    readonly status: Effect.Effect<GlobalHotkeyStatus, GlobalHotkeyError | UserConfigStoreError>;
    start(
      revealMainWindow: () => void,
    ): Effect.Effect<GlobalHotkeyStatus, GlobalHotkeyError | UserConfigStoreError>;
    readonly beginRecording: Effect.Effect<void>;
    readonly cancelRecording: Effect.Effect<
      GlobalHotkeyStatus,
      GlobalHotkeyError | UserConfigStoreError
    >;
    update(
      patch: GlobalHotkeyUpdate,
    ): Effect.Effect<GlobalHotkeyStatus, GlobalHotkeyError | UserConfigStoreError>;
    readonly stop: Effect.Effect<void>;
  }
>()("plakk/main/global-hotkey/GlobalHotkey") {}

const unavailableMessage = "That shortcut is unavailable. Choose a different shortcut.";

const electronKey = (key: string) => {
  switch (key) {
    case "ArrowDown":
      return "Down";
    case "ArrowLeft":
      return "Left";
    case "ArrowRight":
      return "Right";
    case "ArrowUp":
      return "Up";
    default:
      return key;
  }
};

export function portableHotkeyToElectronAccelerator(shortcut: string, platform: DesktopPlatform) {
  const normalized = normalizePortableHotkey(shortcut, platform);
  const parsed = parseHotkey(normalized, platform);
  return [...parsed.modifiers, electronKey(parsed.key)].join("+");
}

export function normalizePortableHotkey(shortcut: string, platform: DesktopPlatform) {
  const validation = validateHotkey(shortcut);
  if (!validation.valid || !hasNonModifierKey(shortcut, platform)) {
    throw new GlobalHotkeyError({
      cause: validation.errors,
      reason: "Choose a complete keyboard shortcut.",
    });
  }
  return normalizeHotkey(shortcut, platform);
}

const statusFrom = (config: UserConfig, state: RegistrationState): GlobalHotkeyStatus => ({
  ...config.globalHotkey,
  errorMessage: state.errorMessage,
});

export const makeGlobalHotkeyLive = (
  platform: GlobalHotkeyPlatform,
  desktopPlatform: DesktopPlatform,
) =>
  Layer.effect(
    GlobalHotkey,
    Effect.gen(function* () {
      const store = yield* UserConfigStore;
      const state = yield* Ref.make<RegistrationState>({
        active: null,
        errorMessage: null,
        recording: false,
      });
      const lock = yield* Semaphore.make(1);
      let revealMainWindow = () => {};

      const register = Effect.fn("GlobalHotkey.register")(function* (
        shortcut: string,
      ): Effect.fn.Return<ActiveRegistration | null, GlobalHotkeyError> {
        const accelerator = yield* Effect.try({
          try: () => portableHotkeyToElectronAccelerator(shortcut, desktopPlatform),
          catch: (cause) =>
            cause instanceof GlobalHotkeyError
              ? cause
              : new GlobalHotkeyError({
                  cause,
                  reason: "Choose a complete keyboard shortcut.",
                }),
        });
        const registered = yield* Effect.try({
          try: () => platform.register(accelerator, revealMainWindow),
          catch: (cause) =>
            new GlobalHotkeyError({
              cause,
              reason: "Plakk could not register this shortcut. Try again.",
            }),
        });
        return registered ? { accelerator, shortcut } : null;
      });

      const unregister = Effect.fn("GlobalHotkey.unregister")(
        (registration: ActiveRegistration | null) =>
          registration === null
            ? Effect.void
            : Effect.sync(() => platform.unregister(registration.accelerator)),
      );

      const restore = Effect.fn("GlobalHotkey.restore")(function* (
        preferences: GlobalHotkeyPreferences,
        errorMessage: string | null,
      ) {
        if (!preferences.enabled) {
          yield* Ref.set(state, { active: null, errorMessage, recording: false });
          return;
        }
        const registration = yield* Effect.result(register(preferences.shortcut));
        const active = Result.isSuccess(registration) ? registration.success : null;
        yield* Ref.set(state, {
          active,
          errorMessage:
            active === null
              ? Result.isFailure(registration)
                ? registration.failure.reason
                : unavailableMessage
              : errorMessage,
          recording: false,
        });
      });

      const readStatus = Effect.fn("GlobalHotkey.status")(function* () {
        const config = yield* store.get;
        return statusFrom(config, yield* Ref.get(state));
      });

      const start = Effect.fn("GlobalHotkey.start")((onTrigger: () => void) =>
        lock.withPermit(
          Effect.gen(function* () {
            revealMainWindow = onTrigger;
            const config = yield* store.get;
            const current = yield* Ref.get(state);
            yield* unregister(current.active);
            yield* restore(config.globalHotkey, null);
            return statusFrom(config, yield* Ref.get(state));
          }),
        ),
      );

      const beginRecording = lock.withPermit(
        Effect.gen(function* () {
          const current = yield* Ref.get(state);
          yield* unregister(current.active);
          yield* Ref.set(state, {
            active: null,
            errorMessage: null,
            recording: true,
          });
        }),
      );

      const cancelRecording = lock.withPermit(
        Effect.gen(function* () {
          const config = yield* store.get;
          const current = yield* Ref.get(state);
          yield* unregister(current.active);
          yield* restore(config.globalHotkey, null);
          return statusFrom(config, yield* Ref.get(state));
        }),
      );

      const normalizeRequestedShortcut = Effect.fn("GlobalHotkey.normalizeRequestedShortcut")(
        (shortcut: string): Effect.Effect<string, GlobalHotkeyError> =>
          Effect.try({
            try: () => normalizePortableHotkey(shortcut, desktopPlatform),
            catch: (cause) =>
              cause instanceof GlobalHotkeyError
                ? cause
                : new GlobalHotkeyError({
                    cause,
                    reason: "Choose a complete keyboard shortcut.",
                  }),
          }),
      );

      const update = Effect.fn("GlobalHotkey.update")((patch: GlobalHotkeyUpdate) =>
        lock.withPermit(
          Effect.gen(function* () {
            const previousConfig = yield* store.get;
            const previousState = yield* Ref.get(state);
            const requestedShortcut = patch.shortcut ?? previousConfig.globalHotkey.shortcut;
            const normalizedShortcut = yield* normalizeRequestedShortcut(requestedShortcut).pipe(
              Effect.tapError((error) =>
                previousState.recording
                  ? restore(previousConfig.globalHotkey, error.reason)
                  : Ref.set(state, {
                      ...previousState,
                      errorMessage: error.reason,
                      recording: false,
                    }),
              ),
            );
            const nextPreferences: GlobalHotkeyPreferences = {
              ...previousConfig.globalHotkey,
              ...patch,
              shortcut: normalizedShortcut,
            };

            if (!nextPreferences.enabled) {
              const nextConfig = yield* store.set({ globalHotkey: nextPreferences });
              yield* unregister(previousState.active);
              yield* Ref.set(state, {
                active: null,
                errorMessage: null,
                recording: false,
              });
              return statusFrom(nextConfig, yield* Ref.get(state));
            }

            const desiredAccelerator = portableHotkeyToElectronAccelerator(
              nextPreferences.shortcut,
              desktopPlatform,
            );
            const canReuseActive =
              previousState.active?.accelerator === desiredAccelerator && !previousState.recording;
            const nextActive = canReuseActive
              ? previousState.active
              : yield* register(nextPreferences.shortcut).pipe(
                  Effect.tapError((error) =>
                    previousState.recording
                      ? restore(previousConfig.globalHotkey, error.reason)
                      : Ref.set(state, {
                          ...previousState,
                          errorMessage: error.reason,
                          recording: false,
                        }),
                  ),
                );

            if (nextActive === null) {
              if (previousState.recording) {
                yield* restore(previousConfig.globalHotkey, unavailableMessage);
              } else {
                yield* Ref.set(state, {
                  ...previousState,
                  errorMessage: unavailableMessage,
                  recording: false,
                });
              }
              return statusFrom(previousConfig, yield* Ref.get(state));
            }

            const nextConfig = yield* store.set({ globalHotkey: nextPreferences }).pipe(
              Effect.tapError(() =>
                Effect.gen(function* () {
                  if (!canReuseActive) yield* unregister(nextActive);
                  if (previousState.recording) {
                    yield* restore(previousConfig.globalHotkey, null);
                  } else {
                    yield* Ref.set(state, previousState);
                  }
                }),
              ),
            );
            if (
              previousState.active !== null &&
              previousState.active.accelerator !== nextActive.accelerator
            ) {
              yield* unregister(previousState.active);
            }
            yield* Ref.set(state, {
              active: nextActive,
              errorMessage: null,
              recording: false,
            });
            return statusFrom(nextConfig, yield* Ref.get(state));
          }),
        ),
      );

      const stop = lock.withPermit(
        Effect.gen(function* () {
          const current = yield* Ref.get(state);
          yield* unregister(current.active);
          yield* Ref.set(state, {
            active: null,
            errorMessage: null,
            recording: false,
          });
        }),
      );

      yield* Effect.acquireRelease(Effect.void, () => stop);

      return GlobalHotkey.of({
        status: lock.withPermit(readStatus()),
        start,
        beginRecording,
        cancelRecording,
        update,
        stop,
      });
    }),
  );
