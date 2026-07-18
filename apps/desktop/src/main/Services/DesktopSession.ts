import type { Effect, Stream } from "effect";
import { Context, Schema } from "effect";

import type { AuthServiceFailure, AuthSession } from "../auth/AuthService.ts";
import type { DesktopAccountPurgeError } from "./DesktopAccountData.ts";
import type { LocalStateError } from "./LocalState.ts";

export type DesktopSessionAccount = {
  readonly id: string;
  readonly accessToken: string | null;
};

export class DesktopSessionSignOutError extends Schema.TaggedErrorClass<DesktopSessionSignOutError>()(
  "DesktopSessionSignOutError",
  { cause: Schema.Defect(), reason: Schema.String },
) {}

export class DesktopSessionCommandError extends Schema.TaggedErrorClass<DesktopSessionCommandError>()(
  "DesktopSessionCommandError",
  { reason: Schema.String },
) {}

export type DesktopSessionTransitionError = DesktopAccountPurgeError | LocalStateError;

export interface DesktopSessionShape {
  readonly issues: Stream.Stream<string>;
  readonly currentAccount: Effect.Effect<DesktopSessionAccount | null>;
  readonly handleCallbackUrl: (
    rawUrl: string,
  ) => Effect.Effect<AuthSession | null, AuthServiceFailure | DesktopSessionTransitionError>;
  readonly refresh: Effect.Effect<void, DesktopSessionTransitionError>;
  readonly start: Effect.Effect<void, DesktopSessionTransitionError>;
  readonly signOut: Effect.Effect<void, DesktopSessionSignOutError>;
  readonly withCurrentAccount: <A, E>(
    command: (account: DesktopSessionAccount) => Effect.Effect<A, E>,
  ) => Effect.Effect<A, E | DesktopSessionCommandError>;
}

export class DesktopSession extends Context.Service<DesktopSession, DesktopSessionShape>()(
  "plakk/main/Services/DesktopSession",
) {}
