import { Effect } from "effect";

import { PlakkRpcClient } from "./PlakkRpcClient.ts";

export const getAccountStatus = Effect.fn("DesktopAccountStatus.get")(function* (
  accessToken: string,
) {
  const client = yield* PlakkRpcClient;
  return yield* client.GetAccountStatus(undefined, {
    headers: { authorization: `Bearer ${accessToken}` },
  });
});

export const isUnauthenticatedAccountError = (error: unknown) =>
  typeof error === "object" &&
  error !== null &&
  "code" in error &&
  error.code === "UNAUTHENTICATED";
