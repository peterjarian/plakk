import { parseExactHttpOrigin } from "@plakk/shared/ExactHttpOrigin";
import * as Data from "effect/Data";

const invalidOriginMessage = "PLAKK_WEB_ORIGIN must be an exact HTTP(S) origin.";

export class InvalidCorsConfiguration extends Data.TaggedError("InvalidCorsConfiguration")<{
  readonly cause: unknown;
  readonly message: string;
}> {}

export const allowedBackendOrigins = (configuredWebOrigin: string): ReadonlyArray<string> => {
  const webOrigin = parseExactHttpOrigin(configuredWebOrigin);
  if (webOrigin === null) {
    throw new InvalidCorsConfiguration({
      cause: configuredWebOrigin,
      message: invalidOriginMessage,
    });
  }
  return ["plakk-app://renderer", webOrigin];
};
