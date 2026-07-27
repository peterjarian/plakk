import {
  parseStorageOnboardingRouteSearch,
  storageOnboardingRouteSearchParams,
} from "@plakk/shared/StorageOnboardingReturn";

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
  const search = parseStorageOnboardingRouteSearch((key) => parsed.searchParams.get(key));
  normalized.search = storageOnboardingRouteSearchParams(search).toString();
  return `${normalized.pathname}${normalized.search}`;
};
