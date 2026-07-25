/** @effect-diagnostics preferSchemaOverJson:skip-file */
import * as Config from "effect/Config";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";

import type { BackendAttributes, BackendProps } from "./Backend.ts";

const RAILWAY_GRAPHQL_ENDPOINT = "https://backboard.railway.com/graphql/v2";

const Edge = <A>(node: Schema.Codec<A, unknown, never, unknown>) => Schema.Struct({ node });
const Connection = <A>(node: Schema.Codec<A, unknown, never, unknown>) =>
  Schema.Struct({ edges: Schema.Array(Edge(node)) });

const Environment = Schema.Struct({ id: Schema.String, name: Schema.String });
const Service = Schema.Struct({ id: Schema.String, name: Schema.String });
const Project = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  description: Schema.NullOr(Schema.String),
  environments: Connection(Environment),
  services: Connection(Service),
});
const ProjectSummary = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  description: Schema.NullOr(Schema.String),
});
const ServiceInstance = Schema.Struct({
  buildCommand: Schema.NullOr(Schema.String),
  startCommand: Schema.NullOr(Schema.String),
  healthcheckPath: Schema.NullOr(Schema.String),
  region: Schema.NullOr(Schema.String),
});
const ServiceDomain = Schema.Struct({
  id: Schema.String,
  domain: Schema.String,
});
const Domains = Schema.Struct({
  serviceDomains: Schema.Array(ServiceDomain),
  customDomains: Schema.Array(Schema.Struct({ id: Schema.String, domain: Schema.String })),
});
const Variables = Schema.Record(Schema.String, Schema.String);
const Id = Schema.Struct({ id: Schema.String });
const CreatedDomain = Schema.Struct({
  id: Schema.String,
  domain: Schema.String,
});
const GraphqlError = Schema.Struct({ message: Schema.String });

export class RailwayApiError extends Schema.TaggedErrorClass<RailwayApiError>()("RailwayApiError", {
  operation: Schema.String,
  message: Schema.String,
  cause: Schema.optional(Schema.Defect()),
}) {}

interface DesiredBackend extends Omit<BackendProps, "variables"> {
  readonly variables: Readonly<Record<string, string>>;
}

interface ReconcileInput {
  readonly desired: DesiredBackend;
  readonly marker: string;
  readonly previous: BackendAttributes | undefined;
}

const configurationOf = (desired: DesiredBackend): string =>
  JSON.stringify({
    projectName: desired.projectName,
    serviceName: desired.serviceName,
    repository: desired.repository,
    branch: desired.branch,
    buildCommand: desired.buildCommand,
    startCommand: desired.startCommand,
    healthcheckPath: desired.healthcheckPath,
    watchPatterns: desired.watchPatterns,
    region: desired.region,
  });

export interface RailwayApiService {
  readonly listManagedBackends: Effect.Effect<Array<BackendAttributes>, RailwayApiError>;
  readonly readBackend: (
    attributes: BackendAttributes,
  ) => Effect.Effect<BackendAttributes, RailwayApiError>;
  readonly reconcileBackend: (
    input: ReconcileInput,
  ) => Effect.Effect<BackendAttributes, RailwayApiError>;
  readonly deleteProject: (projectId: string) => Effect.Effect<void, RailwayApiError>;
  readonly orNotFound: <A>(
    effect: Effect.Effect<A, RailwayApiError>,
  ) => Effect.Effect<A | undefined, RailwayApiError>;
  readonly ignoreNotFound: (
    effect: Effect.Effect<void, RailwayApiError>,
  ) => Effect.Effect<void, RailwayApiError>;
}

export class RailwayApi extends Context.Service<RailwayApi, RailwayApiService>()(
  "@plakk/infra/railway/RailwayApi",
) {}

type Fetch = (input: string | URL | globalThis.Request, init?: RequestInit) => Promise<Response>;

const isNotFound = (error: RailwayApiError) => error.message.toLowerCase().includes("not found");

export const makeRailwayApi = (
  execute: Fetch,
  credentials: Effect.Effect<Redacted.Redacted<string>, RailwayApiError>,
): RailwayApiService => {
  const graphql = <A>(
    operation: string,
    query: string,
    variables: Record<string, unknown>,
    dataSchema: Schema.Codec<A, unknown, never, unknown>,
  ): Effect.Effect<A, RailwayApiError> =>
    Effect.gen(function* () {
      const token = yield* credentials;
      const response = yield* Effect.tryPromise({
        try: () =>
          execute(RAILWAY_GRAPHQL_ENDPOINT, {
            method: "POST",
            headers: {
              authorization: `Bearer ${Redacted.value(token)}`,
              "content-type": "application/json",
            },
            body: JSON.stringify({ query, variables }),
          }),
        catch: (cause) =>
          new RailwayApiError({
            operation,
            message: "Railway request failed",
            cause,
          }),
      });
      if (!response.ok) {
        return yield* new RailwayApiError({
          operation,
          message: `Railway returned HTTP ${response.status}`,
        });
      }
      const body = yield* Effect.tryPromise({
        try: () => response.json(),
        catch: (cause) =>
          new RailwayApiError({
            operation,
            message: "Railway returned invalid JSON",
            cause,
          }),
      });
      const envelope = yield* Schema.decodeUnknownEffect(
        Schema.Struct({
          data: Schema.optional(dataSchema),
          errors: Schema.optional(Schema.Array(GraphqlError)),
        }),
      )(body).pipe(
        Effect.mapError(
          (cause) =>
            new RailwayApiError({
              operation,
              message: "Railway returned an unexpected GraphQL response",
              cause,
            }),
        ),
      );
      const firstError = envelope.errors?.[0];
      if (firstError !== undefined) {
        return yield* new RailwayApiError({
          operation,
          message: firstError.message,
        });
      }
      if (envelope.data === undefined) {
        return yield* new RailwayApiError({
          operation,
          message: "Railway returned no data",
        });
      }
      return envelope.data;
    });

  const getProject = (projectId: string) =>
    graphql(
      "project",
      `
        query project($id: String!) {
          project(id: $id) {
            id
            name
            description
            environments {
              edges {
                node {
                  id
                  name
                }
              }
            }
            services {
              edges {
                node {
                  id
                  name
                }
              }
            }
          }
        }
      `,
      { id: projectId },
      Schema.Struct({ project: Project }),
    ).pipe(Effect.map(({ project }) => project));

  const listProjects = () =>
    graphql(
      "projects",
      `
        query projects {
          projects {
            edges {
              node {
                id
                name
                description
              }
            }
          }
        }
      `,
      {},
      Schema.Struct({ projects: Connection(ProjectSummary) }),
    ).pipe(Effect.map(({ projects }) => projects.edges.map(({ node }) => node)));

  const createProject = (name: string, description: string, workspaceId: string | undefined) =>
    graphql(
      "projectCreate",
      `
        mutation projectCreate($input: ProjectCreateInput!) {
          projectCreate(input: $input) {
            id
          }
        }
      `,
      {
        input: {
          name,
          description,
          defaultEnvironmentName: "production",
          ...(workspaceId === undefined ? {} : { workspaceId }),
        },
      },
      Schema.Struct({ projectCreate: Id }),
    ).pipe(Effect.map(({ projectCreate }) => projectCreate.id));

  const updateProject = (projectId: string, name: string, description: string) =>
    graphql(
      "projectUpdate",
      `
        mutation projectUpdate($id: String!, $input: ProjectUpdateInput!) {
          projectUpdate(id: $id, input: $input) {
            id
          }
        }
      `,
      { id: projectId, input: { name, description } },
      Schema.Struct({ projectUpdate: Id }),
    ).pipe(Effect.asVoid);

  const deleteProject = (projectId: string) =>
    graphql(
      "projectDelete",
      `
        mutation projectDelete($id: String!) {
          projectDelete(id: $id)
        }
      `,
      { id: projectId },
      Schema.Struct({ projectDelete: Schema.Boolean }),
    ).pipe(Effect.asVoid);

  const createService = (projectId: string, desired: DesiredBackend) =>
    graphql(
      "serviceCreate",
      `
        mutation serviceCreate($input: ServiceCreateInput!) {
          serviceCreate(input: $input) {
            id
          }
        }
      `,
      {
        input: {
          projectId,
          name: desired.serviceName,
          source: { repo: desired.repository },
          branch: desired.branch,
        },
      },
      Schema.Struct({ serviceCreate: Id }),
    ).pipe(Effect.map(({ serviceCreate }) => serviceCreate.id));

  const updateService = (serviceId: string, name: string) =>
    graphql(
      "serviceUpdate",
      `
        mutation serviceUpdate($id: String!, $input: ServiceUpdateInput!) {
          serviceUpdate(id: $id, input: $input) {
            id
          }
        }
      `,
      { id: serviceId, input: { name } },
      Schema.Struct({ serviceUpdate: Id }),
    ).pipe(Effect.asVoid);

  const connectService = (serviceId: string, repository: string, branch: string) =>
    graphql(
      "serviceConnect",
      `
        mutation serviceConnect($id: String!, $input: ServiceConnectInput!) {
          serviceConnect(id: $id, input: $input) {
            id
          }
        }
      `,
      { id: serviceId, input: { repo: repository, branch } },
      Schema.Struct({ serviceConnect: Id }),
    ).pipe(Effect.asVoid);

  const getServiceInstance = (serviceId: string, environmentId: string) =>
    graphql(
      "serviceInstance",
      `
        query serviceInstance($serviceId: String!, $environmentId: String!) {
          serviceInstance(serviceId: $serviceId, environmentId: $environmentId) {
            buildCommand
            startCommand
            healthcheckPath
            region
          }
        }
      `,
      { serviceId, environmentId },
      Schema.Struct({ serviceInstance: ServiceInstance }),
    ).pipe(Effect.map(({ serviceInstance }) => serviceInstance));

  const updateServiceInstance = (
    serviceId: string,
    environmentId: string,
    desired: DesiredBackend,
  ) =>
    graphql(
      "serviceInstanceUpdate",
      `
        mutation serviceInstanceUpdate(
          $serviceId: String!
          $environmentId: String!
          $input: ServiceInstanceUpdateInput!
        ) {
          serviceInstanceUpdate(serviceId: $serviceId, environmentId: $environmentId, input: $input)
        }
      `,
      {
        serviceId,
        environmentId,
        input: {
          buildCommand: desired.buildCommand,
          startCommand: desired.startCommand,
          healthcheckPath: desired.healthcheckPath,
          watchPatterns: desired.watchPatterns,
          restartPolicyType: "ON_FAILURE",
          restartPolicyMaxRetries: 10,
          sleepApplication: false,
          ...(desired.region === undefined ? {} : { region: desired.region }),
        },
      },
      Schema.Struct({ serviceInstanceUpdate: Schema.Boolean }),
    ).pipe(Effect.asVoid);

  const getVariables = (projectId: string, environmentId: string, serviceId: string) =>
    graphql(
      "variables",
      `
        query variables($projectId: String!, $environmentId: String!, $serviceId: String) {
          variables(
            projectId: $projectId
            environmentId: $environmentId
            serviceId: $serviceId
            unrendered: true
          )
        }
      `,
      { projectId, environmentId, serviceId },
      Schema.Struct({ variables: Variables }),
    ).pipe(Effect.map(({ variables }) => variables));

  const upsertVariables = (
    projectId: string,
    environmentId: string,
    serviceId: string,
    variables: Readonly<Record<string, string>>,
  ) =>
    graphql(
      "variableCollectionUpsert",
      `
        mutation variableCollectionUpsert($input: VariableCollectionUpsertInput!) {
          variableCollectionUpsert(input: $input)
        }
      `,
      {
        input: {
          projectId,
          environmentId,
          serviceId,
          variables,
          replace: false,
          skipDeploys: true,
        },
      },
      Schema.Struct({ variableCollectionUpsert: Schema.Boolean }),
    ).pipe(Effect.asVoid);

  const getDomains = (projectId: string, environmentId: string, serviceId: string) =>
    graphql(
      "domains",
      `
        query domains($projectId: String!, $environmentId: String!, $serviceId: String!) {
          domains(projectId: $projectId, environmentId: $environmentId, serviceId: $serviceId) {
            serviceDomains {
              id
              domain
            }
            customDomains {
              id
              domain
            }
          }
        }
      `,
      { projectId, environmentId, serviceId },
      Schema.Struct({ domains: Domains }),
    ).pipe(Effect.map(({ domains }) => domains));

  const createDomain = (serviceId: string, environmentId: string) =>
    graphql(
      "serviceDomainCreate",
      `
        mutation serviceDomainCreate($input: ServiceDomainCreateInput!) {
          serviceDomainCreate(input: $input) {
            id
            domain
          }
        }
      `,
      { input: { serviceId, environmentId } },
      Schema.Struct({ serviceDomainCreate: CreatedDomain }),
    ).pipe(Effect.map(({ serviceDomainCreate }) => serviceDomainCreate.domain));

  const deploy = (serviceId: string, environmentId: string) =>
    graphql(
      "serviceInstanceDeployV2",
      `
        mutation serviceInstanceDeployV2($serviceId: String!, $environmentId: String!) {
          serviceInstanceDeployV2(serviceId: $serviceId, environmentId: $environmentId)
        }
      `,
      { serviceId, environmentId },
      Schema.Struct({ serviceInstanceDeployV2: Schema.String }),
    ).pipe(Effect.asVoid);

  const attributesFor = (
    projectId: string,
    environmentId: string,
    serviceId: string,
    configuration: string,
  ) =>
    getDomains(projectId, environmentId, serviceId).pipe(
      Effect.flatMap((domains) => {
        const domain = domains.customDomains[0]?.domain ?? domains.serviceDomains[0]?.domain;
        return domain === undefined
          ? Effect.fail(
              new RailwayApiError({
                operation: "domains",
                message: "Railway backend has no domain",
              }),
            )
          : Effect.succeed({
              projectId,
              environmentId,
              serviceId,
              domain,
              url: `https://${domain}`,
              configuration,
            });
      }),
    );

  const readBackend = (attributes: BackendAttributes) =>
    Effect.gen(function* () {
      const project = yield* getProject(attributes.projectId);
      const hasEnvironment = project.environments.edges.some(
        ({ node }) => node.id === attributes.environmentId,
      );
      const hasService = project.services.edges.some(
        ({ node }) => node.id === attributes.serviceId,
      );
      if (!hasEnvironment || !hasService) {
        return yield* new RailwayApiError({
          operation: "readBackend",
          message: "Railway backend not found",
        });
      }
      return yield* attributesFor(
        attributes.projectId,
        attributes.environmentId,
        attributes.serviceId,
        attributes.configuration,
      );
    });

  const reconcileBackend = ({ desired, marker, previous }: ReconcileInput) =>
    Effect.gen(function* () {
      const configuration = configurationOf(desired);
      let changed = previous?.configuration !== configuration;
      let project =
        previous === undefined
          ? undefined
          : yield* getProject(previous.projectId).pipe(
              Effect.catchIf(isNotFound, () => Effect.void),
            );

      if (project === undefined) {
        const candidates = yield* listProjects();
        const owned = candidates.find(
          (candidate) => candidate.name === desired.projectName && candidate.description === marker,
        );
        const collision = candidates.find(
          (candidate) => candidate.name === desired.projectName && candidate.description !== marker,
        );
        if (owned === undefined && collision !== undefined) {
          return yield* new RailwayApiError({
            operation: "reconcileBackend",
            message: `Railway project '${desired.projectName}' already exists and is not owned by this stack`,
          });
        }
        const projectId =
          owned?.id ?? (yield* createProject(desired.projectName, marker, desired.workspaceId));
        project = yield* getProject(projectId);
        changed = true;
      }

      if (project.name !== desired.projectName || project.description !== marker) {
        yield* updateProject(project.id, desired.projectName, marker);
        changed = true;
      }

      const environment =
        project.environments.edges.find(({ node }) => node.name === "production")?.node ??
        project.environments.edges[0]?.node;
      if (environment === undefined) {
        return yield* new RailwayApiError({
          operation: "reconcileBackend",
          message: "Railway project has no environment",
        });
      }

      const existingService =
        previous === undefined
          ? project.services.edges.find(({ node }) => node.name === desired.serviceName)?.node
          : project.services.edges.find(({ node }) => node.id === previous.serviceId)?.node;
      const serviceId = existingService?.id ?? (yield* createService(project.id, desired));

      if (existingService === undefined) {
        changed = true;
      } else if (existingService.name !== desired.serviceName) {
        yield* updateService(serviceId, desired.serviceName);
        changed = true;
      }
      if (previous?.configuration !== configuration) {
        yield* connectService(serviceId, desired.repository, desired.branch);
      }
      yield* getServiceInstance(serviceId, environment.id).pipe(
        Effect.catchIf(isNotFound, () => Effect.void),
      );
      if (previous?.configuration !== configuration) {
        yield* updateServiceInstance(serviceId, environment.id, desired);
      }

      const currentVariables = yield* getVariables(project.id, environment.id, serviceId);
      const changedVariables = Object.fromEntries(
        Object.entries(desired.variables).filter(
          ([name, value]) => currentVariables[name] !== value,
        ),
      );
      if (Object.keys(changedVariables).length > 0) {
        yield* upsertVariables(project.id, environment.id, serviceId, changedVariables);
        changed = true;
      }

      const domains = yield* getDomains(project.id, environment.id, serviceId);
      const domain =
        domains.customDomains[0]?.domain ??
        domains.serviceDomains[0]?.domain ??
        (yield* createDomain(serviceId, environment.id));
      if (domains.customDomains.length === 0 && domains.serviceDomains.length === 0) {
        changed = true;
      }

      if (changed) {
        yield* deploy(serviceId, environment.id);
      }

      return {
        projectId: project.id,
        environmentId: environment.id,
        serviceId,
        domain,
        url: `https://${domain}`,
        configuration,
      };
    });

  const listManagedBackends = Effect.gen(function* () {
    const projects = yield* listProjects();
    const managed = projects.filter((project) =>
      project.description?.startsWith("Managed by Alchemy ("),
    );
    const backends = yield* Effect.forEach(managed, (summary) =>
      Effect.gen(function* () {
        const project = yield* getProject(summary.id);
        const environment = project.environments.edges[0]?.node;
        const service = project.services.edges[0]?.node;
        if (environment === undefined || service === undefined) {
          return undefined;
        }
        return yield* attributesFor(project.id, environment.id, service.id, "").pipe(
          Effect.orElseSucceed(() => undefined),
        );
      }),
    );
    return backends.filter((backend): backend is BackendAttributes => backend !== undefined);
  });

  const orNotFound = <A>(effect: Effect.Effect<A, RailwayApiError>) =>
    effect.pipe(Effect.catchIf(isNotFound, () => Effect.void.pipe(Effect.as(undefined))));

  const ignoreNotFound = (
    effect: Effect.Effect<void, RailwayApiError>,
  ): Effect.Effect<void, RailwayApiError> =>
    effect.pipe(Effect.catchIf(isNotFound, () => Effect.void));

  return {
    listManagedBackends,
    readBackend,
    reconcileBackend,
    deleteProject,
    orNotFound,
    ignoreNotFound,
  };
};

const credentials = Config.redacted("RAILWAY_API_TOKEN").pipe(
  Effect.mapError(
    (cause) =>
      new RailwayApiError({
        operation: "credentials",
        message: "RAILWAY_API_TOKEN is required",
        cause,
      }),
  ),
);

export const RailwayApiLive = Layer.succeed(
  RailwayApi,
  makeRailwayApi(globalThis.fetch, credentials),
);
