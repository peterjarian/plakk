import { NodeRedis } from "@effect/platform-node";
import * as Config from "effect/Config";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
import { Persistence } from "effect/unstable/persistence";
import type { RedisOptions } from "ioredis";

class RedisConfigurationError extends Schema.TaggedErrorClass<RedisConfigurationError>()(
  "RedisConfigurationError",
  {
    message: Schema.String,
  },
) {}

const RedisUrl = Schema.URLFromString.check(
  Schema.makeFilter(
    (url) =>
      (url.protocol === "redis:" || url.protocol === "rediss:") &&
      (url.pathname === "" || url.pathname === "/" || /^\/\d+$/.test(url.pathname)),
    {
      expected: "a redis: or rediss: URL with an optional numeric database path",
    },
  ),
);

const redisOptions = Config.redacted("REDIS_URL").pipe(
  Effect.flatMap((value) => Schema.decodeUnknownEffect(RedisUrl)(Redacted.value(value))),
  Effect.flatMap((url) =>
    Effect.try({
      try: (): RedisOptions => {
        const database = url.pathname.length > 1 ? Number(url.pathname.slice(1)) : undefined;
        return {
          host: url.hostname,
          port: url.port === "" ? 6379 : Number(url.port),
          ...(url.username === "" ? {} : { username: decodeURIComponent(url.username) }),
          ...(url.password === "" ? {} : { password: decodeURIComponent(url.password) }),
          ...(database === undefined ? {} : { db: database }),
          ...(url.protocol === "rediss:" ? { tls: {} } : {}),
        };
      },
      catch: () =>
        new RedisConfigurationError({
          message: "REDIS_URL contains invalid encoded credentials.",
        }),
    }),
  ),
  Effect.mapError((error) =>
    error instanceof RedisConfigurationError
      ? error
      : new RedisConfigurationError({
          message:
            "REDIS_URL must be a redis: or rediss: URL with an optional numeric database path.",
        }),
  ),
);

const RedisLive = Layer.unwrap(redisOptions.pipe(Effect.map(NodeRedis.layer)));

export const BillingPersistenceLive = Persistence.layerRedis.pipe(Layer.provide(RedisLive));
