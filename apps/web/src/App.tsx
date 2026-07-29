import type { StorageProvider, User } from "@plakk/shared";
import type { User as AuthKitUser } from "@workos/authkit-tanstack-react-start";
import { useState } from "react";

import { useAppearance } from "./hooks/useAppearance.ts";
import { useClientRuntime } from "./hooks/useClientRuntime.ts";
import { useSnippets } from "./hooks/useSnippets.ts";
import { Home } from "./screens/Home.tsx";
import { Settings } from "./screens/Settings.tsx";
import { Welcome } from "./screens/Welcome.tsx";

const toUser = (user: AuthKitUser | null): User | null =>
  user === null
    ? null
    : {
        id: user.id,
        firstName: user.firstName,
        lastName: user.lastName,
        email: user.email,
        createdAt: user.createdAt,
        updatedAt: user.updatedAt,
      };

function useAppModel(user: User | null) {
  const appearance = useAppearance();
  const runtime = useClientRuntime(user);
  const snippets = useSnippets(runtime.snapshot, runtime.run);

  return {
    ...snippets,
    appearance: appearance.preference,
    changeAppearance: appearance.set,
    connectStorage: (storageProvider: StorageProvider) =>
      runtime
        .run((client) => client.storage.beginLink(storageProvider))
        .then((url) => {
          window.location.assign(url);
        }),
    error: runtime.error,
    loading: runtime.loading,
    openExternal: (url: string) => window.open(url, "_blank", "noopener,noreferrer"),
    refresh: runtime.refresh,
    signIn: () => window.location.assign("/api/auth/sign-in"),
    signOut: runtime.signOut,
    user,
  };
}

export type WebAppModel = ReturnType<typeof useAppModel>;

export function App({ initialUser }: { readonly initialUser: AuthKitUser | null }) {
  const plakk = useAppModel(toUser(initialUser));
  const [screen, setScreen] = useState<"home" | "settings">("home");

  if (plakk.user === null) {
    return <Welcome error={plakk.error} loading={plakk.loading} onSignIn={plakk.signIn} />;
  }
  return screen === "settings" ? (
    <Settings plakk={plakk} onBack={() => setScreen("home")} />
  ) : (
    <Home plakk={plakk} onSettings={() => setScreen("settings")} />
  );
}
