import type { Effect, Stream } from "effect";
import { Context, Schema } from "effect";

import type { AuthServiceFailure, AuthSession } from "../auth/AuthService.ts";

export type DesktopSessionAccount = {
  readonly id: string;
  readonly accessToken: string | null;
};

export class DesktopSessionSignOutError extends Schema.TaggedErrorClass<DesktopSessionSignOutError>()(
  "DesktopSessionSignOutError",
  { cause: Schema.Defect(), reason: Schema.String },
) {}

export interface DesktopSessionShape {
  readonly issues: Stream.Stream<string>;
  readonly currentAccount: Effect.Effect<DesktopSessionAccount | null>;
  readonly handleCallbackUrl: (
    rawUrl: string,
  ) => Effect.Effect<AuthSession | null, AuthServiceFailure>;
  readonly refresh: Effect.Effect<void>;
  readonly start: Effect.Effect<void>;
  readonly signOut: Effect.Effect<void, DesktopSessionSignOutError>;
}

export class DesktopSession extends Context.Service<DesktopSession, DesktopSessionShape>()(
  "plakk/main/Services/DesktopSession",
) {}
