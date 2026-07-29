export type ProductFailure = {
  readonly title: string;
  readonly description: string;
};

const failureTag = (cause: unknown): string | null =>
  typeof cause === "object" && cause !== null && "_tag" in cause && typeof cause._tag === "string"
    ? cause._tag
    : null;

export function productFailureFrom(cause: unknown, fallback: ProductFailure): ProductFailure {
  switch (failureTag(cause)) {
    case "OfflineError":
    case "ServerUnavailableError":
      return {
        title: "Can’t reach Plakk",
        description: "Check your connection and try again.",
      };
    case "SessionError":
      return {
        title: "Your session needs attention",
        description: "Refresh the page, then sign in again if the problem continues.",
      };
    case "LocalStorageError":
      return {
        title: "Browser storage is unavailable",
        description: "Reload this tab. Your snippets in connected storage are still safe.",
      };
    case "ActionNotAllowedError":
      return {
        title: "This action isn’t available",
        description: "Check your account and storage setup, then try again.",
      };
    case "SnippetNotFoundError":
      return {
        title: "This snippet is no longer available",
        description: "Refresh the list to see the latest snippets.",
      };
    case "SnippetConflictError":
      return {
        title: "This snippet changed on another device",
        description: "Refresh the list, then try again.",
      };
    case "UploadSourceChangedError":
    case "UploadSourceUnavailableError":
      return {
        title: "Couldn’t read that file",
        description: "Choose the file again and retry.",
      };
    default:
      return fallback;
  }
}
