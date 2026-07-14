import { createFileRoute } from "@tanstack/react-router";

import { handleSnippetChangeEventsRequest } from "@/api/SnippetChangeEvents";

export const Route = createFileRoute("/api/snippet-changes/events")({
  server: {
    handlers: {
      GET: ({ request }) => handleSnippetChangeEventsRequest(request),
    },
  },
});
