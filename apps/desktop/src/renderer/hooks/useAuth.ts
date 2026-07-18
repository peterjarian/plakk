import { createContext, createElement, useContext, useEffect, useMemo, useState } from "react";
import type { AuthError } from "../../ipc/contracts.ts";
import type { ReactNode } from "react";
import { ipcActionErrorMessage } from "../lib/ipcActionErrorMessage.ts";
import { useLocalState } from "./useLocalState.tsx";

type AuthState = {
  readonly issue: AuthError | null;
  readonly isLoading: boolean;
  readonly user: ReturnType<typeof useLocalState>["localState"]["account"];
};

const AuthContext = createContext<AuthState | null>(null);

type AuthCommands = {
  readonly signIn: () => Promise<void>;
  readonly signOut: () => Promise<void>;
};

export const makeAuthCommands = (
  commands: AuthCommands,
  publishIssue: (issue: AuthError | null) => void,
) => {
  const run = async (command: () => Promise<void>, fallback: string) => {
    publishIssue(null);
    try {
      await command();
      return true;
    } catch (cause) {
      publishIssue({ message: ipcActionErrorMessage(cause, fallback) });
      return false;
    }
  };

  return {
    signIn: () => run(commands.signIn, "Couldn’t start sign-in."),
    signOut: () => run(commands.signOut, "Couldn’t sign out of Plakk."),
  };
};

const commandIssueSubscribers = new Set<(issue: AuthError | null) => void>();
const publishCommandIssue = (issue: AuthError | null) => {
  for (const subscriber of commandIssueSubscribers) subscriber(issue);
};
const commands = makeAuthCommands(
  {
    signIn: () => window.ipc.auth.signIn(),
    signOut: () => window.ipc.auth.signOut(),
  },
  publishCommandIssue,
);

export const signIn = commands.signIn;
export const signOut = commands.signOut;

export function AuthProvider({ children }: { children: ReactNode }) {
  const state = useLocalState();
  const [issue, setIssue] = useState<AuthError | null>(null);

  useEffect(() => {
    commandIssueSubscribers.add(setIssue);
    const unsubscribe = window.ipc.auth.onError(setIssue);
    return () => {
      commandIssueSubscribers.delete(setIssue);
      unsubscribe();
    };
  }, []);

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
