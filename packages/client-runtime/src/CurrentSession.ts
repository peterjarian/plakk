import type { User } from "@plakk/shared";
import type { OfflineError, SessionError } from "@plakk/shared/PlakkApi";
import type { Effect } from "effect";
import * as Context from "effect/Context";

/**
 * The user whose local data this runtime is currently serving.
 *
 * The user remains stable for the runtime's lifetime. The access-token effect
 * is evaluated for each protected request so token refresh and temporary
 * offline failures do not require rebuilding the runtime.
 */
export class CurrentSession extends Context.Service<
  CurrentSession,
  {
    readonly user: User;
    readonly accessToken: Effect.Effect<string, OfflineError | SessionError>;
  }
>()("@plakk/client-runtime/CurrentSession") {}
