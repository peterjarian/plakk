import * as Context from "effect/Context";

/**
 * Transport provenance supplied by the authenticated RPC boundary.
 *
 * This is deliberately separate from CurrentUser: request metadata is not an identity fact.
 */
export class AuthenticatedRpcRequest extends Context.Service<
  AuthenticatedRpcRequest,
  { readonly origin: string | null }
>()("@plakk/shared/api/AuthenticatedRpcRequest") {}
