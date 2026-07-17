import {
  createContext,
  createElement,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
} from "react";
import type { AuthError, AuthStatus } from "../../ipc/contracts.ts";
import type { ReactNode } from "react";

type AuthState = {
  issue: AuthError | null;
  isLoading: boolean;
  signIn: () => Promise<void>;
  signOut: () => Promise<void>;
  accessToken: string | null;
  user: AuthStatus["user"];
};

const AuthContext = createContext<AuthState | null>(null);
const AUTH_REFRESH_INTERVAL_MS = 30 * 1000;

export function AuthProvider({ children }: { children: ReactNode }) {
  const [status, setStatus] = useState<AuthStatus | null>(null);
  const [issue, setIssue] = useState<AuthError | null>(null);

  useEffect(() => {
    let isMounted = true;
    const applyStatus = (nextStatus: AuthStatus) => {
      if (!isMounted) return;
      setIssue(null);
      setStatus(nextStatus);
    };
    const reportError = () => {
      if (!isMounted) return;
      setIssue({ message: "Could not check session." });
    };
    const refresh = () => void window.ipc.auth.getAuth().then(applyStatus, reportError);
    const unsubscribeError = window.ipc.auth.onError((error) => {
      if (!isMounted) return;
      setIssue(error);
    });
    const unsubscribe = window.ipc.auth.onStatusChanged(applyStatus);

    void window.ipc.auth.getAuth().then(applyStatus, () => {
      if (!isMounted) return;
      reportError();
      setStatus({ accessToken: null, user: null });
    });
    const refreshInterval = window.setInterval(refresh, AUTH_REFRESH_INTERVAL_MS);
    window.addEventListener("focus", refresh);

    return () => {
      isMounted = false;
      window.clearInterval(refreshInterval);
      window.removeEventListener("focus", refresh);
      unsubscribe();
      unsubscribeError();
    };
  }, []);

  const signIn = useCallback(async () => {
    setIssue(null);
    try {
      await window.ipc.auth.signIn();
    } catch {
      setIssue({ message: "Could not start sign-in." });
    }
  }, []);

  const signOut = useCallback(async () => {
    setIssue(null);
    try {
      await window.ipc.auth.signOut();
    } catch {
      setIssue({ message: "Could not sign out." });
    }
  }, []);

  const value = useMemo(() => {
    const user = status?.user ?? null;

    return {
      accessToken: status?.accessToken ?? null,
      issue,
      isLoading: status === null,
      signIn,
      signOut,
      user,
    };
  }, [issue, signIn, signOut, status]);

  return createElement(AuthContext.Provider, { value }, children);
}

export function useAuth(): AuthState {
  const auth = useContext(AuthContext);
  if (auth === null) throw new Error("useAuth must be used inside AuthProvider.");
  return auth;
}
