import { DesktopAppHandoff } from "../../components/DesktopAppHandoff.tsx";
import { createFileRoute } from "@tanstack/react-router";

export function desktopBillingDeepLink(isDevelopment: boolean): string {
  const protocol = isDevelopment ? "plakk-dev" : "plakk";
  return `${protocol}://billing/success`;
}

function DesktopBillingReturn() {
  const callbackUrl = desktopBillingDeepLink(import.meta.env.DEV);

  return (
    <DesktopAppHandoff
      callbackUrl={callbackUrl}
      title="Return to Plakk"
      description="Plakk is opening and will refresh your billing status. You can close this window."
    />
  );
}

export const Route = createFileRoute("/billing/desktop-return")({
  head: () => ({
    meta: [{ title: "Return to Plakk" }],
  }),
  component: DesktopBillingReturn,
});
