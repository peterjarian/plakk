import { Button } from "@plakk/ui/components/primitives/button";
import * as Effect from "effect/Effect";
import { useMemo, useState } from "react";

import {
  makeBrowserTelemetry,
  makeBrowserTelemetryExporter,
} from "../../src/product/browser-telemetry.ts";

const protectedFailure =
  "private filename.txt clipboard content cookie authorization-code signed-provider-url";

export function Issue132Proof() {
  const [state, setState] = useState("Ready");
  const telemetry = useMemo(
    () =>
      makeBrowserTelemetry({
        exporter: makeBrowserTelemetryExporter(`${location.origin}/api/telemetry/v1/traces`),
      }),
    [],
  );

  const runFailure = async () => {
    setState("Working");
    const result = await Effect.runPromise(
      telemetry
        .observeRpc(
          "snippet.delete",
          { headers: { authorization: "Bearer controlled-browser-token" } },
          (requestOptions) =>
            Effect.tryPromise({
              try: async () => {
                const response = await fetch("/controlled-rpc", {
                  headers: requestOptions.headers,
                  method: "POST",
                });
                if (!response.ok) throw new Error(protectedFailure);
              },
              catch: () => ({ _tag: "ControlledRpcFailure" as const }),
            }),
        )
        .pipe(Effect.result),
    );
    setState(
      result._tag === "Failure" ? "This action could not be completed. Try again." : "Completed",
    );
  };

  return (
    <main>
      <h1>Secure observability proof</h1>
      <p role="status">{state}</p>
      <Button type="button" onClick={() => void runFailure()}>
        Run protected action
      </Button>
    </main>
  );
}
