/** @effect-diagnostics preferSchemaOverJson:skip-file */
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";

import { makeRailwayApi } from "./RailwayApi.ts";

const desiredBackend = {
  projectName: "plakk-production",
  serviceName: "backend",
  repository: "peterjarian/plakk",
  branch: "main",
  variables: {
    DATABASE_URL: "postgres://neon",
    WORKOS_API_KEY: "secret",
  },
  buildCommand: "pnpm build",
  startCommand: "pnpm start",
  healthcheckPath: "/health",
  watchPatterns: ["/apps/backend/**"],
};

const ownershipMarker = "Managed by Alchemy (Backend)";

const makeFixture = () => {
  const calls: Array<string> = [];
  const variables: Record<string, string> = {};
  const variableReplaceValues: Array<boolean> = [];
  let project:
    | {
        id: string;
        name: string;
        description: string;
      }
    | undefined;
  let service: { id: string; name: string } | undefined;
  let sourceRepository: string | null = null;
  let sourceBranch: string | null = null;
  let domain: string | undefined;
  let projectQueryError: string | undefined;
  let domainQueryError: string | undefined;
  let deploymentStatuses: Array<string> = ["SUCCESS"];
  const serviceInstance = {
    buildCommand: null as string | null,
    startCommand: null as string | null,
    healthcheckPath: null as string | null,
    region: null as string | null,
    restartPolicyMaxRetries: 0,
    restartPolicyType: "NEVER",
    sleepApplication: null as boolean | null,
    watchPatterns: [] as Array<string>,
  };

  const execute = async (_input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    if (typeof init?.body !== "string") {
      throw new Error("Expected a JSON request body");
    }
    const request = JSON.parse(init.body) as {
      query: string;
      variables: Record<string, unknown>;
    };
    const query = request.query;
    const reply = (data: unknown) =>
      new Response(JSON.stringify({ data }), {
        headers: { "content-type": "application/json" },
      });
    const graphqlError = (message: string) =>
      new Response(JSON.stringify({ errors: [{ message }] }), {
        headers: { "content-type": "application/json" },
      });

    if (query.includes("query projects")) {
      calls.push("projects");
      return reply({
        projects: {
          edges: project === undefined ? [] : [{ node: project }],
        },
      });
    }
    if (query.includes("mutation projectCreate")) {
      calls.push("projectCreate");
      const input = request.variables.input as {
        name: string;
        description: string;
      };
      project = {
        id: "project-1",
        name: input.name,
        description: input.description,
      };
      return reply({ projectCreate: { id: project.id } });
    }
    if (query.includes("query project(")) {
      calls.push("project");
      if (projectQueryError !== undefined) {
        return graphqlError(projectQueryError);
      }
      if (project === undefined) {
        return graphqlError("Project not found");
      }
      return reply({
        project: {
          ...project,
          environments: {
            edges: [
              {
                node: { id: "environment-1", name: "production" },
              },
            ],
          },
          services: {
            edges: service === undefined ? [] : [{ node: service }],
          },
        },
      });
    }
    if (query.includes("mutation projectUpdate")) {
      calls.push("projectUpdate");
      const input = request.variables.input as {
        name: string;
        description: string;
      };
      if (project !== undefined) {
        project.name = input.name;
        project.description = input.description;
      }
      return reply({ projectUpdate: { id: "project-1" } });
    }
    if (query.includes("mutation serviceCreate")) {
      calls.push("serviceCreate");
      const input = request.variables.input as {
        name: string;
        source: { repo: string };
        branch: string;
      };
      service = { id: "service-1", name: input.name };
      sourceRepository = input.source.repo;
      sourceBranch = input.branch;
      return reply({ serviceCreate: { id: service.id } });
    }
    if (query.includes("mutation serviceUpdate")) {
      calls.push("serviceUpdate");
      return reply({ serviceUpdate: { id: "service-1" } });
    }
    if (query.includes("mutation serviceConnect")) {
      calls.push("serviceConnect");
      const input = request.variables.input as { repo: string; branch: string };
      sourceRepository = input.repo;
      sourceBranch = input.branch;
      return reply({ serviceConnect: { id: "service-1" } });
    }
    if (query.includes("query serviceInstance")) {
      calls.push("serviceInstance");
      if (service === undefined) {
        return graphqlError("Service instance not found");
      }
      return reply({
        serviceInstance: {
          ...serviceInstance,
          source: sourceRepository === null ? null : { repo: sourceRepository },
          service: {
            repoTriggers: {
              edges:
                sourceRepository === null || sourceBranch === null
                  ? []
                  : [
                      {
                        node: {
                          branch: sourceBranch,
                          environmentId: "environment-1",
                          repository: sourceRepository,
                        },
                      },
                    ],
            },
          },
        },
      });
    }
    if (query.includes("mutation serviceInstanceUpdate")) {
      calls.push("serviceInstanceUpdate");
      const input = request.variables.input as typeof serviceInstance;
      Object.assign(serviceInstance, input);
      return reply({ serviceInstanceUpdate: true });
    }
    if (query.includes("query variables(")) {
      calls.push("variables");
      return reply({ variables });
    }
    if (query.includes("mutation variableCollectionUpsert")) {
      calls.push("variableCollectionUpsert");
      const input = request.variables.input as {
        variables: Record<string, string>;
        replace: boolean;
      };
      variableReplaceValues.push(input.replace);
      if (input.replace) {
        for (const name of Object.keys(variables)) {
          delete variables[name];
        }
      }
      Object.assign(variables, input.variables);
      return reply({ variableCollectionUpsert: true });
    }
    if (query.includes("query domains(")) {
      calls.push("domains");
      if (domainQueryError !== undefined) {
        return graphqlError(domainQueryError);
      }
      return reply({
        domains: {
          serviceDomains: domain === undefined ? [] : [{ id: "domain-1", domain }],
          customDomains: [],
        },
      });
    }
    if (query.includes("mutation serviceDomainCreate")) {
      calls.push("serviceDomainCreate");
      domain = "plakk-production.up.railway.app";
      return reply({
        serviceDomainCreate: { id: "domain-1", domain },
      });
    }
    if (query.includes("mutation serviceInstanceDeployV2")) {
      calls.push("serviceInstanceDeployV2");
      return reply({ serviceInstanceDeployV2: "deployment-1" });
    }
    if (query.includes("query deployment(")) {
      calls.push("deployment");
      const status = deploymentStatuses.shift() ?? "SUCCESS";
      return reply({ deployment: { id: "deployment-1", status } });
    }
    if (query.includes("mutation projectDelete")) {
      calls.push("projectDelete");
      project = undefined;
      service = undefined;
      domain = undefined;
      return reply({ projectDelete: true });
    }
    return graphqlError(`Unexpected operation: ${query}`);
  };

  return {
    api: makeRailwayApi(execute, Effect.succeed(Redacted.make("railway-token"))),
    calls,
    variables,
    variableReplaceValues,
    removeDomain: () => {
      domain = undefined;
    },
    setDomainQueryError: (message: string | undefined) => {
      domainQueryError = message;
    },
    setProjectQueryError: (message: string | undefined) => {
      projectQueryError = message;
    },
    setDeploymentStatuses: (...statuses: Array<string>) => {
      deploymentStatuses = statuses;
    },
    driftSource: (repository: string, branch: string) => {
      sourceRepository = repository;
      sourceBranch = branch;
    },
    driftServiceInstance: (buildCommand: string, watchPatterns: Array<string>) => {
      serviceInstance.buildCommand = buildCommand;
      serviceInstance.watchPatterns = watchPatterns;
    },
    setProjectDescription: (description: string) => {
      if (project !== undefined) {
        project.description = description;
      }
    },
    setRegion: (region: string) => {
      serviceInstance.region = region;
    },
  };
};

describe("RailwayApi", () => {
  it.effect("converges a backend without duplicating or redeploying it", () =>
    Effect.gen(function* () {
      const fixture = makeFixture();

      const first = yield* fixture.api.reconcileBackend({
        desired: desiredBackend,
        marker: ownershipMarker,
        previous: undefined,
      });
      const second = yield* fixture.api.reconcileBackend({
        desired: desiredBackend,
        marker: ownershipMarker,
        previous: first,
      });

      expect(second).toEqual(first);
      expect(fixture.calls.filter((call) => call === "projectCreate")).toHaveLength(1);
      expect(fixture.calls.filter((call) => call === "serviceCreate")).toHaveLength(1);
      expect(fixture.calls.filter((call) => call === "serviceDomainCreate")).toHaveLength(1);
      expect(fixture.calls.filter((call) => call === "serviceInstanceDeployV2")).toHaveLength(1);
      expect(fixture.variableReplaceValues).toEqual([true]);

      yield* fixture.api.deleteProject(first.projectId);
      expect(fixture.calls.at(-1)).toBe("projectDelete");
    }),
  );

  it.effect("repairs live source and service setting drift", () =>
    Effect.gen(function* () {
      const fixture = makeFixture();
      const first = yield* fixture.api.reconcileBackend({
        desired: desiredBackend,
        marker: ownershipMarker,
        previous: undefined,
      });

      fixture.driftSource("other/repository", "develop");
      fixture.driftServiceInstance("wrong build", []);

      const observed = yield* fixture.api.readBackend(first);
      expect(observed.configuration).not.toBe(first.configuration);

      const repaired = yield* fixture.api.reconcileBackend({
        desired: desiredBackend,
        marker: ownershipMarker,
        previous: observed,
      });
      expect(yield* fixture.api.readBackend(repaired)).toEqual(repaired);

      expect(fixture.calls.filter((call) => call === "serviceConnect")).toHaveLength(1);
      expect(fixture.calls.filter((call) => call === "serviceInstanceUpdate")).toHaveLength(2);
      expect(fixture.calls.filter((call) => call === "serviceInstanceDeployV2")).toHaveLength(2);
    }),
  );

  it.effect("ignores Railway's default region when region is not managed", () =>
    Effect.gen(function* () {
      const fixture = makeFixture();
      const first = yield* fixture.api.reconcileBackend({
        desired: desiredBackend,
        marker: ownershipMarker,
        previous: undefined,
      });
      fixture.setRegion("us-west1");

      const observed = yield* fixture.api.readBackend(first);
      expect(observed).toEqual(first);

      const reconciled = yield* fixture.api.reconcileBackend({
        desired: desiredBackend,
        marker: ownershipMarker,
        previous: observed,
      });
      expect(reconciled).toEqual(first);
      expect(fixture.calls.filter((call) => call === "serviceInstanceDeployV2")).toHaveLength(1);
    }),
  );

  it.effect("exposes and repairs ownership marker drift", () =>
    Effect.gen(function* () {
      const fixture = makeFixture();
      const first = yield* fixture.api.reconcileBackend({
        desired: desiredBackend,
        marker: ownershipMarker,
        previous: undefined,
      });
      fixture.setProjectDescription("changed outside Alchemy");

      const observed = yield* fixture.api.readBackend(first);
      expect(observed.configuration).not.toBe(first.configuration);

      const repaired = yield* fixture.api.reconcileBackend({
        desired: desiredBackend,
        marker: ownershipMarker,
        previous: observed,
      });
      expect(yield* fixture.api.readBackend(repaired)).toEqual(repaired);
      expect(fixture.calls.filter((call) => call === "projectUpdate")).toHaveLength(1);
      expect(fixture.calls.filter((call) => call === "serviceInstanceDeployV2")).toHaveLength(2);
    }),
  );

  it.effect("removes variables deleted from desired state", () =>
    Effect.gen(function* () {
      const fixture = makeFixture();
      const first = yield* fixture.api.reconcileBackend({
        desired: desiredBackend,
        marker: ownershipMarker,
        previous: undefined,
      });

      yield* fixture.api.reconcileBackend({
        desired: {
          ...desiredBackend,
          variables: { DATABASE_URL: desiredBackend.variables.DATABASE_URL },
        },
        marker: ownershipMarker,
        previous: first,
      });

      expect(fixture.variables).toEqual({
        DATABASE_URL: desiredBackend.variables.DATABASE_URL,
      });
      expect(fixture.variableReplaceValues).toEqual([true, true]);
    }),
  );

  it.effect("exposes live variable drift and reconciles it", () =>
    Effect.gen(function* () {
      const fixture = makeFixture();
      const first = yield* fixture.api.reconcileBackend({
        desired: desiredBackend,
        marker: ownershipMarker,
        previous: undefined,
      });
      fixture.variables.UNMANAGED = "drift";

      const observed = yield* fixture.api.readBackend(first);
      expect(observed.variablesFingerprint).not.toBe(first.variablesFingerprint);

      const repaired = yield* fixture.api.reconcileBackend({
        desired: desiredBackend,
        marker: ownershipMarker,
        previous: observed,
      });
      expect(yield* fixture.api.readBackend(repaired)).toEqual(repaired);
      expect(fixture.variables).toEqual(desiredBackend.variables);
    }),
  );

  it.effect("recreates a generated domain deleted outside Alchemy", () =>
    Effect.gen(function* () {
      const fixture = makeFixture();
      const first = yield* fixture.api.reconcileBackend({
        desired: desiredBackend,
        marker: ownershipMarker,
        previous: undefined,
      });
      fixture.removeDomain();

      const read = yield* fixture.api.readBackend(first).pipe(fixture.api.orNotFound);
      expect(read).toBeUndefined();

      const repaired = yield* fixture.api.reconcileBackend({
        desired: desiredBackend,
        marker: ownershipMarker,
        previous: first,
      });
      expect(repaired.domain).toBe("plakk-production.up.railway.app");
      expect(fixture.calls.filter((call) => call === "serviceDomainCreate")).toHaveLength(2);
    }),
  );

  it.effect("propagates inventory failures instead of omitting managed projects", () =>
    Effect.gen(function* () {
      const fixture = makeFixture();
      yield* fixture.api.reconcileBackend({
        desired: desiredBackend,
        marker: ownershipMarker,
        previous: undefined,
      });
      fixture.setDomainQueryError("Railway rate limit exceeded");

      const error = yield* Effect.flip(fixture.api.listManagedBackends);
      expect(error).toMatchObject({
        _tag: "RailwayApiError",
        operation: "domains",
        message: "Railway rate limit exceeded",
      });
    }),
  );

  it.effect("does not mistake unrelated GraphQL messages for resource absence", () =>
    Effect.gen(function* () {
      const fixture = makeFixture();
      const backend = yield* fixture.api.reconcileBackend({
        desired: desiredBackend,
        marker: ownershipMarker,
        previous: undefined,
      });
      fixture.setProjectQueryError("Authorization scope not found for this token");

      const error = yield* Effect.flip(
        fixture.api.readBackend(backend).pipe(fixture.api.orNotFound),
      );
      expect(error).toMatchObject({
        _tag: "RailwayApiError",
        operation: "project",
        message: "Authorization scope not found for this token",
      });
    }),
  );

  it.effect("fails reconciliation when the Railway deployment fails", () =>
    Effect.gen(function* () {
      const fixture = makeFixture();
      fixture.setDeploymentStatuses("FAILED");

      const error = yield* Effect.flip(
        fixture.api.reconcileBackend({
          desired: desiredBackend,
          marker: ownershipMarker,
          previous: undefined,
        }),
      );
      expect(error).toMatchObject({
        _tag: "RailwayApiError",
        operation: "deployment",
        message: "Railway deployment 'deployment-1' finished with status FAILED",
      });
    }),
  );
});
