import type { ReactNode } from "react";

export function TrayShell({ children }: { children: ReactNode }) {
  return (
    <main className="flex h-screen flex-col overflow-hidden bg-background text-foreground">
      {children}
    </main>
  );
}
