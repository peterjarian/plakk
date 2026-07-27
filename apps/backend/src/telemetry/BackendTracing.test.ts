import { describe, expect, it } from "vite-plus/test";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Tracer from "effect/Tracer";
import { HttpMiddleware, HttpServerRequest, HttpServerResponse } from "effect/unstable/http";

describe("backend request tracing", () => {
  it("joins the server span to an incoming W3C browser action trace", async () => {
    const traceId = "0123456789abcdef0123456789abcdef";
    const browserSpanId = "0123456789abcdef";
    let serverSpan: Tracer.NativeSpan | undefined;
    const tracer = Tracer.make({
      span(options) {
        serverSpan = new Tracer.NativeSpan(options);
        return serverSpan;
      },
    });
    const request = HttpServerRequest.fromWeb(
      new Request("https://api.plakk.io/api/rpc", {
        headers: {
          traceparent: `00-${traceId}-${browserSpanId}-01`,
        },
        method: "POST",
      }),
    );

    await Effect.runPromise(
      HttpMiddleware.tracer(Effect.succeed(HttpServerResponse.empty())).pipe(
        Effect.provideService(HttpServerRequest.HttpServerRequest, request),
        Effect.provideService(Tracer.Tracer, tracer),
      ),
    );

    expect(serverSpan?.traceId).toBe(traceId);
    const parent = Option.getOrUndefined(serverSpan?.parent ?? Option.none());
    expect(parent).toMatchObject({
      sampled: true,
      spanId: browserSpanId,
      traceId,
    });
  });
});
