import { DesktopAppHandoff } from "../../../components/DesktopAppHandoff.tsx";
import { createFileRoute, useLocation } from "@tanstack/react-router";

export function desktopAuthDeepLink(search: string, isDevelopment: boolean): string {
  const query = search.length === 0 || search.startsWith("?") ? search : `?${search}`;
  const protocol = isDevelopment ? "plakk-dev" : "plakk";
  return `${protocol}://auth/callback${query}`;
}

function DesktopAuthCallback() {
  const search = useLocation({ select: (location) => location.searchStr });
  const callbackUrl = desktopAuthDeepLink(search, import.meta.env.DEV);

  return (
    <DesktopAppHandoff
      callbackUrl={callbackUrl}
      title="You’re all set"
      description="Plakk is opening. You can close this window and continue in the desktop app."
    />
  );
}

export const Route = createFileRoute("/auth/desktop/callback")({
  head: () => ({
    meta: [{ title: "Sign-in complete · Plakk" }],
  }),
  component: DesktopAuthCallback,
});
