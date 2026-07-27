import { createCsrfMiddleware } from "@tanstack/react-start";

export const isProtectedServerFunction = (context: { readonly handlerType: string }): boolean =>
  context.handlerType === "serverFn";

export const webCsrfMiddleware = createCsrfMiddleware({
  filter: isProtectedServerFunction,
});
