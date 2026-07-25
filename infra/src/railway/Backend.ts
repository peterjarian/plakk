import { Resource } from "alchemy";
import * as Provider from "alchemy/Provider";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import { RailwayApi } from "./RailwayApi.ts";
import type { Providers } from "./Providers.ts";

export type RailwayVariable = string | Redacted.Redacted<string>;

export interface BackendProps {
  readonly projectName: string;
  readonly serviceName: string;
  readonly repository: string;
  readonly branch: string;
  readonly workspaceId?: string;
  readonly variables: Readonly<Record<string, RailwayVariable>>;
  readonly buildCommand: string;
  readonly startCommand: string;
  readonly healthcheckPath: string;
  readonly watchPatterns: ReadonlyArray<string>;
  readonly region?: string;
}

export interface BackendAttributes {
  readonly projectId: string;
  readonly environmentId: string;
  readonly serviceId: string;
  readonly domain: string;
  readonly url: string;
  readonly configuration: string;
}

export type Backend = Resource<
  "Railway.Backend",
  BackendProps,
  BackendAttributes,
  never,
  Providers
>;

/**
 * A deliberately narrow Railway resource that owns one project and one
 * GitHub-backed backend service.
 */
export const Backend = Resource<Backend>("Railway.Backend");

const ownershipMarker = (fqn: string) => `Managed by Alchemy (${fqn})`;

const revealVariables = (
  variables: Readonly<Record<string, RailwayVariable>>,
): Record<string, string> =>
  Object.fromEntries(
    Object.entries(variables).map(([name, value]) => [
      name,
      Redacted.isRedacted(value) ? Redacted.value(value) : value,
    ]),
  );

export const BackendProvider = Provider.effect(
  Backend,
  RailwayApi.pipe(
    Effect.map((api) =>
      Backend.Provider.of({
        stables: ["projectId", "environmentId", "serviceId"],
        list: () => api.listManagedBackends,
        read: ({ output }) =>
          output === undefined
            ? Effect.void.pipe(Effect.as(undefined))
            : api.readBackend(output).pipe(api.orNotFound),
        reconcile: ({ id, news, output }) =>
          api.reconcileBackend({
            desired: {
              ...news,
              variables: revealVariables(news.variables),
            },
            marker: ownershipMarker(id),
            previous: output,
          }),
        delete: ({ output }) => api.deleteProject(output.projectId).pipe(api.ignoreNotFound),
      }),
    ),
  ),
);
