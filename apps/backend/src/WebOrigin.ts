import { parseExactHttpOrigin } from "@plakk/shared/ExactHttpOrigin";

export const configuredWebOrigin = (value: string, requireHttps = false): string => {
  const origin = parseExactHttpOrigin(value);
  if (origin === null || (requireHttps && !origin.startsWith("https://"))) {
    throw new TypeError(
      requireHttps
        ? "PLAKK_WEB_ORIGIN must be an exact HTTPS origin in production."
        : "PLAKK_WEB_ORIGIN must be an exact HTTP(S) origin.",
    );
  }
  return origin;
};
