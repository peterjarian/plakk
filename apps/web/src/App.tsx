import { useState } from "react";

import { usePlakk } from "./hooks/usePlakk.ts";
import { Home } from "./screens/Home.tsx";
import { Settings } from "./screens/Settings.tsx";
import { Welcome } from "./screens/Welcome.tsx";

export function App() {
  const plakk = usePlakk();
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
