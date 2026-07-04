import { ArrowRight } from "lucide-react";
import { Button } from "@plakk/ui/components/primitives/button";
import { SnippetFlowAnimation } from "../components/SnippetFlowAnimation/index.js";
import { navigate } from "../lib/navigate.js";

export function Welcome() {
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

          <Button type="button" className="h-10 w-full" onClick={() => navigate("home")}>
            Sign in
            <ArrowRight />
          </Button>
        </section>
      </div>
    </main>
  );
}
