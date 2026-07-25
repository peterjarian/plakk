export const ipcActionErrorMessage = (cause: unknown, fallback: string): string =>
  cause instanceof Error && cause.message.trim().length > 0 ? cause.message : fallback;
