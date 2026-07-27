const providerTransferOrigins = [
  "https://content.dropboxapi.com",
  "https://graph.microsoft.com",
  "https://*.up.1drv.com",
  "https://www.googleapis.com",
] as const;

export const webSecurityHeaders = (options: {
  readonly apiOrigin: string;
  readonly production: boolean;
}): Readonly<Record<string, string | undefined>> => {
  const connectSources = ["'self'", options.apiOrigin, ...providerTransferOrigins];
  const policy = [
    "default-src 'self'",
    "base-uri 'none'",
    `connect-src ${connectSources.join(" ")}`,
    "font-src 'self'",
    "form-action 'self'",
    "frame-ancestors 'none'",
    "img-src 'self' blob: data:",
    "manifest-src 'self'",
    "media-src 'none'",
    "object-src 'none'",
    // TanStack Start emits inline streaming/hydration script elements. Attribute
    // handlers remain forbidden, and no third-party script origin is admitted.
    "script-src 'self' 'unsafe-inline'",
    "script-src-attr 'none'",
    "style-src 'self' 'unsafe-inline'",
    "worker-src 'self' blob:",
  ];
  if (options.production) policy.push("upgrade-insecure-requests");
  const headers: Record<string, string> = {
    "Content-Security-Policy": policy.join("; "),
    "Cross-Origin-Opener-Policy": "same-origin",
    "Permissions-Policy":
      "camera=(), display-capture=(), geolocation=(), microphone=(), payment=(), usb=()",
    "Referrer-Policy": "no-referrer",
    "X-Content-Type-Options": "nosniff",
    "X-Frame-Options": "DENY",
  };
  if (options.production) {
    headers["Strict-Transport-Security"] = "max-age=63072000; includeSubDomains; preload";
  }
  return headers;
};
