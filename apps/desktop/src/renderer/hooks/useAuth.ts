import { createContext, createElement, useContext, useEffect, useMemo, useState } from "react";
import type { AuthError } from "../../ipc/contracts.ts";
import type { ReactNode } from "react";
import { useLocalState } from "./useLocalState.tsx";

type AuthState = {
  readonly issue: AuthError | null;
  readonly isLoading: boolean;
  readonly user: ReturnType<typeof useLocalState>["localState"]["account"];
};

const AuthContext = createContext<AuthState | null>(null);

export const signIn = () => window.ipc.auth.signIn();
export const signOut = () => window.ipc.auth.signOut();

export function AuthProvider({ children }: { children: ReactNode }) {
  const state = useLocalState();
  const [issue, setIssue] = useState<AuthError | null>(null);

  useEffect(() => window.ipc.auth.onError(setIssue), []);

  const value = useMemo(
    () => ({
      issue,
      isLoading: state.isLoading,
      user: state.localState.account,
    }),
    [issue, state.isLoading, state.localState.account],
  );

  return createElement(AuthContext.Provider, { value }, children);
}

export function useAuth(): AuthState {
  const auth = useContext(AuthContext);
  if (auth === null) throw new Error("useAuth must be used inside AuthProvider.");
  return auth;
}
