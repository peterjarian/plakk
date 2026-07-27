import { createFileRoute, redirect } from "@tanstack/react-router";
import { getSignInUrl } from "@workos/authkit-tanstack-react-start";

import { trustedAuthReturnPath } from "../../-auth-return.ts";

export const Route = createFileRoute("/api/auth/sign-in")({
  server: {
    handlers: {
      GET: async ({ request }) => {
        const returnPathname = trustedAuthReturnPath(
          new URL(request.url).searchParams.get("returnPathname"),
        );
        const url = await getSignInUrl(
          returnPathname === undefined ? undefined : { data: { returnPathname } },
        );

        throw redirect({ href: url });
      },
    },
  },
});
