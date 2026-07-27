import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

const WINDOW_MILLIS = 60_000;
const MAX_EXPORTS_PER_WINDOW = 60;

export class BrowserTelemetryRateLimiter extends Context.Service<
  BrowserTelemetryRateLimiter,
  {
    readonly allow: (workosUserId: string) => Effect.Effect<boolean>;
  }
>()("@plakk/backend/telemetry/BrowserTelemetryRateLimiter") {}

export const BrowserTelemetryRateLimiterLive = Layer.sync(BrowserTelemetryRateLimiter, () => {
  const windows = new Map<string, { count: number; startedAt: number }>();
  return BrowserTelemetryRateLimiter.of({
    allow: (workosUserId) =>
      Clock.currentTimeMillis.pipe(
        Effect.map((now) => {
          const current = windows.get(workosUserId);
          if (current === undefined || now - current.startedAt >= WINDOW_MILLIS) {
            windows.set(workosUserId, { count: 1, startedAt: now });
            return true;
          }
          if (current.count >= MAX_EXPORTS_PER_WINDOW) return false;
          current.count += 1;
          return true;
        }),
      ),
  });
});
