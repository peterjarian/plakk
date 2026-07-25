/** @effect-diagnostics preferSchemaOverJson:skip-file */
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";

import { makeRailwayApi } from "./RailwayApi.ts";

describe("RailwayApi", () => {
  it.effect("converges a backend without duplicating or redeploying it", () =>
    Effect.gen(function* () {
      const calls: Array<string> = [];
      let project:
        | {
            id: string;
            name: string;
            description: string;
          }
        | undefined;
      let service: { id: string; name: string } | undefined;
      let domain: string | undefined;
      const variables: Record<string, string> = {};

      const execute = async (
        _input: string | URL | Request,
        init?: RequestInit,
      ): Promise<Response> => {
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
          if (project === undefined) {
            return new Response(
              JSON.stringify({
                errors: [{ message: "Project not found" }],
              }),
              { headers: { "content-type": "application/json" } },
            );
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
          return reply({ projectUpdate: { id: "project-1" } });
        }
        if (query.includes("mutation serviceCreate")) {
          calls.push("serviceCreate");
          const input = request.variables.input as { name: string };
          service = { id: "service-1", name: input.name };
          return reply({ serviceCreate: { id: service.id } });
        }
        if (query.includes("mutation serviceConnect")) {
          calls.push("serviceConnect");
          return reply({ serviceConnect: { id: "service-1" } });
        }
        if (query.includes("query serviceInstance")) {
          calls.push("serviceInstance");
          return reply({
            serviceInstance: {
              buildCommand: null,
              startCommand: null,
              healthcheckPath: null,
              region: null,
            },
          });
        }
        if (query.includes("mutation serviceInstanceUpdate")) {
          calls.push("serviceInstanceUpdate");
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
          };
          Object.assign(variables, input.variables);
          return reply({ variableCollectionUpsert: true });
        }
        if (query.includes("query domains(")) {
          calls.push("domains");
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
        if (query.includes("mutation projectDelete")) {
          calls.push("projectDelete");
          project = undefined;
          service = undefined;
          domain = undefined;
          return reply({ projectDelete: true });
        }
        return new Response(
          JSON.stringify({
            errors: [{ message: `Unexpected operation: ${query}` }],
          }),
          { headers: { "content-type": "application/json" } },
        );
      };

      const api = makeRailwayApi(execute, Effect.succeed(Redacted.make("railway-token")));
      const desired = {
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

      const first = yield* api.reconcileBackend({
        desired,
        marker: "Managed by Alchemy (Backend)",
        previous: undefined,
      });
      const second = yield* api.reconcileBackend({
        desired,
        marker: "Managed by Alchemy (Backend)",
        previous: first,
      });

      expect(second).toEqual(first);
      expect(calls.filter((call) => call === "projectCreate")).toHaveLength(1);
      expect(calls.filter((call) => call === "serviceCreate")).toHaveLength(1);
      expect(calls.filter((call) => call === "serviceDomainCreate")).toHaveLength(1);
      expect(calls.filter((call) => call === "serviceInstanceDeployV2")).toHaveLength(1);

      yield* api.deleteProject(first.projectId);
      expect(calls.at(-1)).toBe("projectDelete");
    }),
  );
});
