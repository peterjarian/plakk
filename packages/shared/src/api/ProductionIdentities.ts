export const PLAKK_PRODUCTION_IDENTITIES = {
  api: "https://api.plakk.io",
  desktopReleases: "https://releases.plakk.io",
  marketing: "https://plakk.io",
  web: "https://app.plakk.io",
} as const;

export const PLAKK_PRODUCTION_AUTH_CALLBACK_URL =
  `${PLAKK_PRODUCTION_IDENTITIES.web}/api/auth/callback` as const;

export const PLAKK_PRODUCTION_STORAGE_RETURN_URL =
  `${PLAKK_PRODUCTION_IDENTITIES.web}/storage` as const;
