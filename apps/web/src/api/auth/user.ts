import type { User } from "@plakk/shared";
import type { AuthKitCore } from "@workos/authkit-session";
import type { User as WorkOSUser } from "@workos-inc/node";
import { createRemoteJWKSet, jwtVerify } from "jose";

const jwksByUrl = new Map<string, ReturnType<typeof createRemoteJWKSet>>();

const publicKeyFor = (jwksUrl: string) => {
  const cached = jwksByUrl.get(jwksUrl);
  if (cached !== undefined) return cached;

  const publicKey = createRemoteJWKSet(new URL(jwksUrl));
  jwksByUrl.set(jwksUrl, publicKey);
  return publicKey;
};

const stringClaim = (value: unknown) => (typeof value === "string" ? value : null);

export const userFromWorkOSUser = (user: WorkOSUser): User => ({
  id: user.id,
  firstName: user.firstName,
  lastName: user.lastName,
  email: user.email,
  createdAt: user.createdAt,
  updatedAt: user.updatedAt,
});

export const userFromWorkOSAccessToken = async (
  token: string,
  jwksUrl: string,
  authKitCore: AuthKitCore,
): Promise<User | null> => {
  await jwtVerify(token, publicKeyFor(jwksUrl));
  const claims = authKitCore.parseTokenClaims<Record<string, unknown>>(token);
  const email = stringClaim(claims.email);

  if (claims.sub === undefined || email === null) return null;

  return {
    id: claims.sub,
    firstName: stringClaim(claims.first_name),
    lastName: stringClaim(claims.last_name),
    email,
    createdAt: null,
    updatedAt: null,
  };
};
