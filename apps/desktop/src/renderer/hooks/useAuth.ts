import {
  createContext,
  createElement,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
} from "react";
import type { User } from "@plakk/shared";
import type { ReactNode } from "react";

type AuthState = {
  issue: { message: string } | null;
  isLoading: boolean;
  signIn: () => Promise<void>;
  signOut: () => Promise<void>;
  user: User | null;
};

const AuthContext = createContext<AuthState | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [isLoading, setIsLoading] = useState(true);
  const [user, setUser] = useState<User | null>(null);
  const [issue, setIssue] = useState<{ message: string } | null>(null);

  useEffect(() => {
    let isMounted = true;
    const unsubscribeError = window.ipc.auth.onError((error) => {
      if (!isMounted) return;
      setIssue(error);
    });
    const unsubscribe = window.ipc.auth.onStatusChanged((nextStatus) => {
      if (!isMounted) return;
      setIssue(null);
      setIsLoading(false);
      setUser(nextStatus.user);
    });

    void window.ipc.auth.getAuth().then(
      (nextStatus) => {
        if (!isMounted) return;
        setIssue(null);
        setIsLoading(false);
        setUser(nextStatus.user);
      },
      (error) => {
        if (!isMounted) return;
        setIssue({ message: error instanceof Error ? error.message : "Could not check session." });
        setIsLoading(false);
        setUser(null);
      },
    );

    return () => {
      isMounted = false;
      unsubscribe();
      unsubscribeError();
    };
  }, []);

  const signIn = useCallback(async () => {
    setIssue(null);
    try {
      await window.ipc.auth.signIn();
    } catch (error) {
      setIssue({ message: error instanceof Error ? error.message : "Could not start sign-in." });
    }
  }, []);

  const signOut = useCallback(async () => {
    setIssue(null);
    try {
      await window.ipc.auth.signOut();
    } catch (error) {
      setIssue({ message: error instanceof Error ? error.message : "Could not sign out." });
    }
  }, []);

  const value = useMemo(() => {
    return {
      issue,
      isLoading,
      signIn,
      signOut,
      user,
    };
  }, [isLoading, issue, signIn, signOut, user]);

  return createElement(AuthContext.Provider, { value }, children);
}

export function useAuth(): AuthState {
  const auth = useContext(AuthContext);
  if (auth === null) throw new Error("useAuth must be used inside AuthProvider.");
  return auth;
}
