import { createFileRoute, getRouteApi } from "@tanstack/react-router";
import { App } from "../App.tsx";

const rootRoute = getRouteApi("__root__");

function IndexRoute() {
  const { user } = rootRoute.useLoaderData();
  return <App initialUser={user} />;
}

export const Route = createFileRoute("/")({ component: IndexRoute });
