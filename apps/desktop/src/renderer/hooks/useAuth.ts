import { createContext, createElement, useContext, useEffect, useMemo, useState } from "react";
import type { AuthError } from "../../ipc/contracts.ts";
import type { ReactNode } from "react";
import { useDesktopProjection } from "./useDesktopProjection.tsx";

type AuthState = {
  readonly issue: AuthError | null;
  readonly isLoading: boolean;
  readonly user: ReturnType<typeof useDesktopProjection>["projection"]["account"];
};

const AuthContext = createContext<AuthState | null>(null);

export const signIn = () => window.ipc.auth.signIn();
export const signOut = () => window.ipc.auth.signOut();

export function AuthProvider({ children }: { children: ReactNode }) {
  const projection = useDesktopProjection();
  const [issue, setIssue] = useState<AuthError | null>(null);

  useEffect(() => window.ipc.auth.onError(setIssue), []);

  const value = useMemo(
    () => ({
      issue,
      isLoading: projection.isLoading,
      user: projection.projection.account,
    }),
    [issue, projection.isLoading, projection.projection.account],
  );

  return createElement(AuthContext.Provider, { value }, children);
}

export function useAuth(): AuthState {
  const auth = useContext(AuthContext);
  if (auth === null) throw new Error("useAuth must be used inside AuthProvider.");
  return auth;
}
