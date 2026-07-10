import { describe, expect, it } from "vite-plus/test";

import { deleteSnippetOptions } from "./snippets.ts";

const headers = { authorization: "Bearer token" };

describe("snippet atom options", () => {
  it("builds mutation options on the shared RPC shape", () => {
    expect(deleteSnippetOptions(headers, "8c72d6f6-9a25-4633-b72f-d8f83cf1c8e0").payload).toEqual({
      id: "8c72d6f6-9a25-4633-b72f-d8f83cf1c8e0",
    });
  });
});
