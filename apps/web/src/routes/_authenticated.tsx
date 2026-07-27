import { createFileRoute, Outlet, redirect } from "@tanstack/react-router";
import { getAuth } from "@workos/authkit-tanstack-react-start";

export const Route = createFileRoute("/_authenticated")({
  loader: async ({ location }) => {
    const auth = await getAuth();
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
