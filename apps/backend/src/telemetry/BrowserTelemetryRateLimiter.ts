import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

const WINDOW_MILLIS = 60_000;
const MAX_EXPORTS_PER_WINDOW = 60;
const MAX_TRACKED_IDENTITIES = 10_000;

type BrowserTelemetryRateLimiterService = {
  readonly allow: (workosUserId: string) => Effect.Effect<boolean>;
};

export class BrowserTelemetryRateLimiter extends Context.Service<
  BrowserTelemetryRateLimiter,
  BrowserTelemetryRateLimiterService
>()("@plakk/backend/telemetry/BrowserTelemetryRateLimiter") {}

export const makeBrowserTelemetryRateLimiter = (
  maxTrackedIdentities = MAX_TRACKED_IDENTITIES,
): BrowserTelemetryRateLimiterService => {
  const windows = new Map<string, { count: number; startedAt: number }>();
  return BrowserTelemetryRateLimiter.of({
    allow: (workosUserId) =>
      Clock.currentTimeMillis.pipe(
        Effect.map((now) => {
          const current = windows.get(workosUserId);
          if (current === undefined || now - current.startedAt >= WINDOW_MILLIS) {
            for (const [userId, window] of windows) {
              if (now - window.startedAt >= WINDOW_MILLIS) windows.delete(userId);
            }
            while (windows.size >= maxTrackedIdentities) {
              const oldestUserId = windows.keys().next().value;
              if (oldestUserId === undefined) break;
              windows.delete(oldestUserId);
            }
            windows.set(workosUserId, { count: 1, startedAt: now });
            return true;
          }
          if (current.count >= MAX_EXPORTS_PER_WINDOW) return false;
          current.count += 1;
          return true;
        }),
      ),
  });
};

export const BrowserTelemetryRateLimiterLive = Layer.sync(
  BrowserTelemetryRateLimiter,
  makeBrowserTelemetryRateLimiter,
);
