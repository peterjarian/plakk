import { createFileRoute } from "@tanstack/react-router";
import { getAuth } from "@workos/authkit-tanstack-react-start";
import * as Config from "effect/Config";
import * as Effect from "effect/Effect";

const backendInvalidationsUrl = Config.string("PLAKK_RPC_URL").pipe(
  Config.withDefault("http://localhost:3100/api/rpc"),
  Config.map((rpcUrl) => {
    const url = new URL(rpcUrl);
    url.pathname = url.pathname.replace(/\/rpc$/, "/snippets/invalidations");
    return url.toString();
  }),
);

const proxySnippetInvalidations = Effect.fn("proxySnippetInvalidations")(function* (
  request: Request,
) {
  const url = yield* backendInvalidationsUrl;
  const headers = new Headers(request.headers);
  headers.delete("cookie");
  if (!headers.has("authorization")) {
    const auth = yield* Effect.tryPromise(() => getAuth());
    if (auth.user !== null) headers.set("authorization", `Bearer ${auth.accessToken}`);
  }
  const forwarded = yield* Effect.try(
    () => new Request(url, { headers, method: "GET", signal: request.signal }),
  );
  return yield* Effect.tryPromise(() => fetch(forwarded));
});

export const Route = createFileRoute("/api/snippets/invalidations")({
  server: {
    handlers: {
      GET: ({ request }) => Effect.runPromise(proxySnippetInvalidations(request)),
    },
  },
});
