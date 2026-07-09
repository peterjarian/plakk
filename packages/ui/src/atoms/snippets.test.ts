import { describe, expect, it } from "vite-plus/test";

import { createTextSnippetOptions, deleteSnippetOptions } from "./snippets.ts";

const headers = { authorization: "Bearer token" };

describe("snippet atom options", () => {
  it("builds mutation options on the shared RPC shape", () => {
    const createOptions = createTextSnippetOptions(headers, "hello");

    expect(createOptions.headers).toBe(headers);
    expect(createOptions.payload.text).toBe("hello");
    expect(createOptions.payload.id).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
    expect(deleteSnippetOptions(headers, "8c72d6f6-9a25-4633-b72f-d8f83cf1c8e0").payload).toEqual({
      id: "8c72d6f6-9a25-4633-b72f-d8f83cf1c8e0",
    });
  });
});
