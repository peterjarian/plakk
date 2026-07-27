import { it } from "@effect/vitest";
import { expect } from "vite-plus/test";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { TestClock } from "effect/testing";

import {
  BrowserTelemetryRateLimiter,
  BrowserTelemetryRateLimiterLive,
} from "./BrowserTelemetryRateLimiter.ts";

it.effect("limits each authenticated user to one bounded window", () =>
  Effect.gen(function* () {
    const limiter = yield* BrowserTelemetryRateLimiter;
    yield* TestClock.setTime(1_000);

    const admitted = yield* Effect.forEach(
      Array.from({ length: 60 }),
      () => limiter.allow("workos-user-a"),
      { concurrency: 1 },
    );
    expect(admitted).toEqual(Array.from({ length: 60 }, () => true));
    expect(yield* limiter.allow("workos-user-a")).toBe(false);
    expect(yield* limiter.allow("workos-user-b")).toBe(true);

    yield* TestClock.adjust("1 minute");
    expect(yield* limiter.allow("workos-user-a")).toBe(true);
  }).pipe(Effect.provide(Layer.merge(BrowserTelemetryRateLimiterLive, TestClock.layer()))),
);
