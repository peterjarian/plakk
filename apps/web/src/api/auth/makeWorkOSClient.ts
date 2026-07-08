import { WorkOS } from "@workos-inc/node";
import * as Effect from "effect/Effect";

export const makeWorkOSClient = Effect.fn("makeWorkOSClient")((apiKey: string, clientId: string) =>
  Effect.succeed(new WorkOS({ apiKey, clientId })),
);
