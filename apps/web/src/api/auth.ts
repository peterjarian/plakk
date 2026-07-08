import type { User } from "@plakk/shared";
import type { User as WorkOSUser } from "@workos-inc/node";
import { createRemoteJWKSet, jwtVerify, type JWTPayload } from "jose";

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
): Promise<User | null> => {
  const { payload } = await jwtVerify<JWTPayload & Record<string, unknown>>(
    token,
    publicKeyFor(jwksUrl),
  );
  const email = stringClaim(payload.email);

  if (payload.sub === undefined || email === null) return null;

  return {
    id: payload.sub,
    firstName: stringClaim(payload.first_name),
    lastName: stringClaim(payload.last_name),
    email,
    createdAt: null,
    updatedAt: null,
  };
};
