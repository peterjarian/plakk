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

export const getAccountStatusWithConnection = Effect.fn("DesktopAccountStatus.getWithConnection")(
  function* (accessToken: string) {
    const client = yield* PlakkRpcClient;
    const account = yield* getAccountStatus(accessToken);
    const connection =
      account.storageProvider === null
        ? null
        : yield* client.GetPipeConnectionStatus(
            { storageProvider: account.storageProvider },
            { headers: { authorization: `Bearer ${accessToken}` } },
          );
    return { account, connection };
  },
);

export const isUnauthenticatedAccountError = (error: unknown) =>
  typeof error === "object" &&
  error !== null &&
  "code" in error &&
  error.code === "UNAUTHENTICATED";
