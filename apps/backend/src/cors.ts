import * as Data from "effect/Data";

const invalidOriginMessage = "PLAKK_WEB_ORIGIN must be an exact HTTP(S) origin.";

export class InvalidCorsConfiguration extends Data.TaggedError("InvalidCorsConfiguration")<{
  readonly cause: unknown;
  readonly message: string;
}> {}

export const allowedBackendOrigins = (configuredWebOrigin: string): ReadonlyArray<string> => {
  let url: URL;
  try {
    url = new URL(configuredWebOrigin);
  } catch (cause) {
    throw new InvalidCorsConfiguration({ cause, message: invalidOriginMessage });
  }
  if (
    !["http:", "https:"].includes(url.protocol) ||
    url.username !== "" ||
    url.password !== "" ||
    url.pathname !== "/" ||
    url.search !== "" ||
    url.hash !== ""
  ) {
    throw new InvalidCorsConfiguration({
      cause: configuredWebOrigin,
      message: invalidOriginMessage,
    });
  }
  return ["plakk-app://renderer", url.origin];
};
