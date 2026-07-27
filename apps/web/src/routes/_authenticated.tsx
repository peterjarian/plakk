import { createFileRoute, Outlet, redirect } from "@tanstack/react-router";

export const Route = createFileRoute("/_authenticated")({
  loader: ({ context, location }) => {
    const auth = context.auth;
    if (auth.user === null) {
      const returnPathname = encodeURIComponent(location.pathname);
      throw redirect({
        href: `/api/auth/sign-in?returnPathname=${returnPathname}`,
      });
    }
    return auth;
  },
  component: Outlet,
});
