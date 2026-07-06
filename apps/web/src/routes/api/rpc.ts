import { createFileRoute } from "@tanstack/react-router";

import { handleRpcRequest } from "#/api/rpc";

export const Route = createFileRoute("/api/rpc")({
  server: {
    handlers: {
      POST: ({ request }) => handleRpcRequest(request),
    },
  },
});
