const trustedProductRoutes = new Set(["/snippets", "/storage"]);

export const trustedAuthReturnPath = (value: string | null): string | undefined => {
  if (value === null || !value.startsWith("/") || value.startsWith("//")) return undefined;

  const trustedOrigin = "https://app.plakk.invalid";
  const parsed = new URL(value, trustedOrigin);
  if (parsed.origin !== trustedOrigin || !trustedProductRoutes.has(parsed.pathname)) {
    return undefined;
  }
  if (parsed.pathname === "/snippets") return "/snippets";

  const normalized = new URL("/storage", trustedOrigin);
  const provider = parsed.searchParams.get("provider");
  if (["GOOGLE_DRIVE", "ONE_DRIVE", "DROPBOX"].includes(provider ?? "")) {
    normalized.searchParams.set("provider", provider!);
  }
  if (parsed.searchParams.get("origin") === "desktop") {
    normalized.searchParams.set("origin", "desktop");
  }
  if (parsed.searchParams.get("confirmation") === "provider") {
    normalized.searchParams.set("confirmation", "provider");
  }
  return `${normalized.pathname}${normalized.search}`;
};
