import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Result from "effect/Result";

export function desktopBillingCallbackUrl(isPackaged: boolean): URL {
  const protocol = isPackaged ? "plakk:" : "plakk-dev:";
  return new URL(`${protocol}//billing/success`);
}

export function parseTrustedBillingCallbackUrl(rawUrl: string, callbackUrl: URL): URL | null {
  if (!URL.canParse(rawUrl)) return null;

  const url = new URL(rawUrl);
  return url.protocol === callbackUrl.protocol &&
    url.username === callbackUrl.username &&
    url.password === callbackUrl.password &&
    url.host === callbackUrl.host &&
    url.pathname === callbackUrl.pathname &&
    url.search === "" &&
    url.hash === ""
    ? url
    : null;
}

export const refreshBillingUntilSubscribed = Effect.fn("BillingCallback.refreshUntilSubscribed")(
  function* <E>(options: {
    readonly refresh: Effect.Effect<void, E>;
    readonly isSubscribed: Effect.Effect<boolean>;
    readonly attempts?: number;
    readonly interval?: Duration.Input;
  }) {
    const attempts = options.attempts ?? 15;
    const interval = options.interval ?? Duration.seconds(2);
    let lastFailure: E | undefined;
    let lastAttemptFailed = false;

    for (let attempt = 0; attempt < attempts; attempt += 1) {
      const refresh = yield* Effect.result(options.refresh);
      if (Result.isSuccess(refresh)) {
        lastAttemptFailed = false;
        lastFailure = undefined;
        if (yield* options.isSubscribed) return true;
      } else {
        lastAttemptFailed = true;
        lastFailure = refresh.failure;
      }
      if (attempt < attempts - 1) yield* Effect.sleep(interval);
    }

    if (lastAttemptFailed) {
      yield* Effect.logWarning("Billing refresh failed throughout the return window", {
        error: lastFailure,
      });
    }
    return false;
  },
);
