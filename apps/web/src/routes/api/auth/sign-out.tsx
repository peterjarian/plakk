import { createFileRoute } from "@tanstack/react-router";
import { signOut } from "@workos/authkit-tanstack-react-start";

export const Route = createFileRoute("/api/auth/sign-out")({
  loader: () => signOut({ data: { returnTo: "/" } }),
});
