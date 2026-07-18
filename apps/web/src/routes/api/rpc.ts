import { createFileRoute } from "@tanstack/react-router";
import { getAuth } from "@workos/authkit-tanstack-react-start";
import * as Config from "effect/Config";
import * as Effect from "effect/Effect";

const backendRpcUrl = Config.string("PLAKK_RPC_URL").pipe(
  Config.withDefault("http://localhost:3100/api/rpc"),
);

const proxyRpcRequest = Effect.fn("proxyRpcRequest")(function* (request: Request) {
  const url = yield* backendRpcUrl;
  const headers = new Headers(request.headers);
  headers.delete("cookie");
  if (!headers.has("authorization")) {
    const auth = yield* Effect.tryPromise(() => getAuth());
    if (auth.user !== null) headers.set("authorization", `Bearer ${auth.accessToken}`);
  }
  const forwarded = yield* Effect.try(() => new Request(new Request(url, request), { headers }));
  return yield* Effect.tryPromise(() => fetch(forwarded));
});

export const Route = createFileRoute("/api/rpc")({
  server: {
    handlers: {
      POST: ({ request }) => Effect.runPromise(proxyRpcRequest(request)),
    },
  },
});
