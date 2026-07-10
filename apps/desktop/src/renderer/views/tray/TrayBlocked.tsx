import { CreditCard, HardDrive, LoaderCircle, RefreshCw } from "lucide-react";
import { Button } from "@plakk/ui/components/primitives/button";
import type { TrayAccountState } from "../../../ipc/contracts.ts";

type TrayBlocker = "billing" | "failed" | "loading" | "storage";

const billingUrl = "https://app.plakk.io/billing";
const storageUrl = "https://app.plakk.io/storage";

export const trayBlockers = (state: TrayAccountState): TrayBlocker[] => {
  if (state.kind === "loading") return ["loading"];
  if (state.kind === "failed") return ["failed"];
  const reasons: TrayBlocker[] = [...state.account.blockedReasons];
  if (state.account.storageProvider === null && !reasons.includes("storage"))
    reasons.push("storage");
  return reasons.length === 0 && !state.account.canSync ? ["failed"] : reasons;
};

export function TrayBlocked({ state }: { state: TrayAccountState }) {
  const blockers = trayBlockers(state);
  const loading = blockers.includes("loading");
  const failed = blockers.includes("failed");

  return (
    <section className="grid min-h-0 flex-1 place-content-center gap-4 p-8 text-center">
      <span className="mx-auto flex size-11 items-center justify-center rounded-full bg-muted text-muted-foreground">
        {loading ? (
          <LoaderCircle className="size-5 animate-spin" />
        ) : (
          <RefreshCw className="size-5" />
        )}
      </span>
      <div className="grid gap-1">
        <h1 className="text-base font-semibold">
          {loading
            ? "Checking account readiness"
            : failed
              ? "Account status unavailable"
              : "Finish account setup"}
        </h1>
        <p className="text-sm text-muted-foreground">
          {loading || failed
            ? "Adding snippets stays disabled until your account is confirmed ready."
            : "Complete the required steps before adding snippets from the tray."}
        </p>
      </div>
      {!loading && !failed && (
        <div className="grid gap-2">
          {blockers.includes("billing") && (
            <Button type="button" onClick={() => void window.ipc.openExternal(billingUrl)}>
              <CreditCard /> Resolve billing
            </Button>
          )}
          {blockers.includes("storage") && (
            <Button
              type="button"
              variant="outline"
              onClick={() => void window.ipc.openExternal(storageUrl)}
            >
              <HardDrive /> Connect storage
            </Button>
          )}
        </div>
      )}
    </section>
  );
}
