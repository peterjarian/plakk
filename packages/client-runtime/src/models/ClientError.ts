import { Schema } from "effect";

/** The current user is not allowed to perform the requested operation. */
export class ActionNotAllowedError extends Schema.TaggedErrorClass<ActionNotAllowedError>()(
  "ActionNotAllowedError",
  { message: Schema.String },
) {}

/** A dependency returned data that the client runtime could not safely use. */
export class InvalidResponseError extends Schema.TaggedErrorClass<InvalidResponseError>()(
  "InvalidResponseError",
  { message: Schema.String },
) {}

/** SQLite or native content storage could not complete a local operation. */
export class LocalStorageError extends Schema.TaggedErrorClass<LocalStorageError>()(
  "LocalStorageError",
  { message: Schema.String },
) {}

/** The backend could not complete an otherwise valid operation. */
export class ServerUnavailableError extends Schema.TaggedErrorClass<ServerUnavailableError>()(
  "ServerUnavailableError",
  { message: Schema.String },
) {}

/** A snippet changed remotely before the requested operation completed. */
export class SnippetConflictError extends Schema.TaggedErrorClass<SnippetConflictError>()(
  "SnippetConflictError",
  { message: Schema.String },
) {}

/** The requested snippet no longer exists in the backend. */
export class SnippetNotFoundError extends Schema.TaggedErrorClass<SnippetNotFoundError>()(
  "SnippetNotFoundError",
  { message: Schema.String },
) {}
