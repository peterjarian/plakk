import type { ReactNode } from "react";

export function TrayShell({ children }: { children: ReactNode }) {
  return (
    <main className="flex h-screen flex-col overflow-hidden bg-background text-foreground">
      <header className="drag-region flex h-9 shrink-0 items-center justify-between border-b px-4">
        <span className="text-sm font-semibold">Plakk</span>
        <span className="text-[11px] font-medium text-muted-foreground">Tray</span>
      </header>
      {children}
    </main>
  );
}
