import { ArrowRight } from "lucide-react";
import { Button } from "@plakk/ui/components/primitives/button";
import { useEffect } from "react";
import { SnippetFlowAnimation } from "../components/SnippetFlowAnimation/index.tsx";
import { signIn, useAuth } from "../hooks/useAuth.ts";
import { navigate } from "../lib/navigate.ts";

export function Welcome() {
  const auth = useAuth();

  useEffect(() => {
    if (auth.user !== null) navigate("home");
  }, [auth.user]);

  return (
    <main className="flex h-screen flex-col overflow-hidden bg-background text-foreground">
      <div className="drag-region grid min-h-0 flex-1 place-items-center p-6">
        <section className="grid w-full max-w-lg gap-4">
          <div className="grid gap-1 text-center">
            <p className="text-xs font-medium tracking-wide text-muted-foreground uppercase">
              Plakk
            </p>
            <h1 className="text-2xl leading-tight font-semibold">Move snippets between devices.</h1>
          </div>

          <SnippetFlowAnimation />

          {auth.issue && (
            <p className="text-center text-xs text-muted-foreground">{auth.issue.message}</p>
          )}

          <Button
            type="button"
            className="h-10 w-full"
            disabled={auth.isLoading}
            onClick={() => void signIn()}
          >
            {auth.isLoading ? "Checking session..." : "Sign in"}
            <ArrowRight />
          </Button>
        </section>
      </div>
    </main>
  );
}
