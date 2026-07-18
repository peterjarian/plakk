import type { User } from "@plakk/shared";
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

export const userFromWorkOSAccessToken = async (
  token: string,
  jwksUrl: string,
): Promise<User | null> => {
  const { payload: claims } = await jwtVerify(token, publicKeyFor(jwksUrl));
  const id = stringClaim(claims.sub);

  if (id === null) return null;

  return {
    id,
    firstName: stringClaim(claims.first_name),
    lastName: stringClaim(claims.last_name),
    email: stringClaim(claims.email),
    createdAt: null,
    updatedAt: null,
  };
};
