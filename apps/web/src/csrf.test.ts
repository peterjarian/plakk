import { describe, expect, it, vi } from "vite-plus/test";

import { isProtectedServerFunction, webCsrfMiddleware } from "./csrf.ts";

const runMiddleware = (
  request: Request,
  handlerType: "router" | "serverFn",
  next = vi.fn(() =>
    Promise.resolve({
      context: undefined,
      pathname: new URL(request.url).pathname,
      request,
      response: new Response("accepted"),
    }),
  ),
) => {
  const server = webCsrfMiddleware.options.server;
  if (server === undefined) throw new Error("CSRF server middleware is missing.");
  return server({
    context: undefined,
    handlerType,
    next: next as never,
    pathname: new URL(request.url).pathname,
    request,
  });
};

describe("TanStack server-function CSRF", () => {
  it("keeps the protection scoped to server functions", () => {
    expect(isProtectedServerFunction({ handlerType: "serverFn" })).toBe(true);
    expect(isProtectedServerFunction({ handlerType: "router" })).toBe(false);
  });

  it("rejects cross-site server functions and admits same-origin requests", async () => {
    const rejectedNext = vi.fn(() =>
      Promise.resolve({
        context: undefined,
        pathname: "/_server/action",
        request: new Request("https://app.plakk.io/_server/action"),
        response: new Response("must not run"),
      }),
    );
    const rejected = await runMiddleware(
      new Request("https://app.plakk.io/_server/action", {
        headers: { origin: "https://attacker.example" },
        method: "POST",
      }),
      "serverFn",
      rejectedNext,
    );
    expect(rejected).toBeInstanceOf(Response);
    expect((rejected as Response).status).toBe(403);
    expect(rejectedNext).not.toHaveBeenCalled();

    const admittedNext = vi.fn(() =>
      Promise.resolve({
        context: undefined,
        pathname: "/_server/action",
        request: new Request("https://app.plakk.io/_server/action"),
        response: new Response("accepted"),
      }),
    );
    const admitted = await runMiddleware(
      new Request("https://app.plakk.io/_server/action", {
        headers: { origin: "https://app.plakk.io" },
        method: "POST",
      }),
      "serverFn",
      admittedNext,
    );
    expect(admitted).not.toBeInstanceOf(Response);
    expect((admitted as { readonly response: Response }).response.status).toBe(200);
    expect(admittedNext).toHaveBeenCalledOnce();
  });
});
