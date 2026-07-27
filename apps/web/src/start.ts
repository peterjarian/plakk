import { createMiddleware, createStart } from "@tanstack/react-start";
import { authkitMiddleware } from "@workos/authkit-tanstack-react-start";

import { webCsrfMiddleware } from "./csrf.ts";
import { webSecurityHeaders } from "./security-headers.ts";
import { validateWebProductionEnvironmentOnStartup } from "./server-production-config.ts";

validateWebProductionEnvironmentOnStartup();

const production = process.env.NODE_ENV === "production";
const apiOrigin =
  process.env.VITE_PLAKK_API_ORIGIN ?? (production ? undefined : "http://localhost:3100");
if (apiOrigin === undefined) {
  throw new Error("VITE_PLAKK_API_ORIGIN is required in production.");
}
const securityHeaders = webSecurityHeaders({ apiOrigin, production });
const securityHeadersMiddleware = createMiddleware().server(async ({ next }) => {
  const result = await next();
  for (const [name, value] of Object.entries(securityHeaders)) {
    if (value !== undefined) result.response.headers.set(name, value);
  }
  return result;
});

export const startInstance = createStart(() => ({
  requestMiddleware: [securityHeadersMiddleware, webCsrfMiddleware, authkitMiddleware()],
}));
