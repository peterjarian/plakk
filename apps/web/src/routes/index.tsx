import { buttonVariants } from "@plakk/ui/components/primitives/button";
import { createFileRoute, redirect } from "@tanstack/react-router";
import { getAuth } from "@workos/authkit-tanstack-react-start";

export const Route = createFileRoute("/")({
  loader: async () => {
    const { user } = await getAuth();
    if (user !== null) throw redirect({ to: "/snippets" });
  },
  component: Welcome,
});

function Welcome() {
  return (
    <main className="grid min-h-screen place-items-center bg-background px-6 text-foreground">
      <section className="grid w-full max-w-lg gap-7 text-center">
        <div className="grid gap-2">
          <p className="text-xs font-medium tracking-wide text-muted-foreground uppercase">Plakk</p>
          <h1 className="text-3xl leading-tight font-semibold tracking-tight">
            Move snippets between devices.
          </h1>
          <p className="text-sm text-muted-foreground">
            Sign in to see the published snippets owned by your account.
          </p>
        </div>
        <a
          href="/api/auth/sign-in?returnPathname=%2Fsnippets"
          className={buttonVariants({ className: "h-10 w-full", size: "lg" })}
        >
          Sign in
        </a>
      </section>
    </main>
  );
}
