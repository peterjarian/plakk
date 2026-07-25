/** @effect-diagnostics preferSchemaOverJson:skip-file */
import * as Config from "effect/Config";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import * as Schedule from "effect/Schedule";
import * as Schema from "effect/Schema";
import { createHash } from "node:crypto";

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
  restartPolicyMaxRetries: Schema.Finite,
  restartPolicyType: Schema.String,
  sleepApplication: Schema.NullOr(Schema.Boolean),
  source: Schema.NullOr(
    Schema.Struct({
      repo: Schema.NullOr(Schema.String),
    }),
  ),
  watchPatterns: Schema.Array(Schema.String),
  service: Schema.Struct({
    repoTriggers: Connection(
      Schema.Struct({
        branch: Schema.String,
        environmentId: Schema.String,
        repository: Schema.String,
      }),
    ),
  }),
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
const Deployment = Schema.Struct({
  id: Schema.String,
  status: Schema.String,
});
const GraphqlError = Schema.Struct({
  message: Schema.String,
  extensions: Schema.optional(
    Schema.Struct({
      code: Schema.optional(Schema.String),
    }),
  ),
});

export class RailwayApiError extends Schema.TaggedErrorClass<RailwayApiError>()("RailwayApiError", {
  operation: Schema.String,
  message: Schema.String,
  cause: Schema.optional(Schema.Defect()),
}) {}

export class RailwayNotFoundError extends Schema.TaggedErrorClass<RailwayNotFoundError>()(
  "RailwayNotFoundError",
  {
    operation: Schema.String,
    resource: Schema.String,
  },
) {}

export type RailwayApiFailure = RailwayApiError | RailwayNotFoundError;

interface DesiredBackend extends Omit<BackendProps, "variables"> {
  readonly variables: Readonly<Record<string, string>>;
}

interface ReconcileInput {
  readonly desired: DesiredBackend;
  readonly marker: string;
  readonly previous: BackendAttributes | undefined;
}

const configurationOf = (desired: DesiredBackend, marker: string): string =>
  JSON.stringify({
    projectName: desired.projectName,
    projectDescription: marker,
    serviceName: desired.serviceName,
    repository: desired.repository,
    branch: desired.branch,
    buildCommand: desired.buildCommand,
    startCommand: desired.startCommand,
    healthcheckPath: desired.healthcheckPath,
    watchPatterns: desired.watchPatterns,
    region: desired.region,
    restartPolicyMaxRetries: 10,
    restartPolicyType: "ON_FAILURE",
    sleepApplication: false,
  });

const observedConfigurationOf = (
  projectName: string,
  projectDescription: string | null,
  serviceName: string,
  environmentId: string,
  instance: typeof ServiceInstance.Type,
  managesRegion: boolean,
): string => {
  const trigger = instance.service.repoTriggers.edges.find(
    ({ node }) => node.environmentId === environmentId,
  )?.node;
  return JSON.stringify({
    projectName,
    projectDescription,
    serviceName,
    repository: instance.source?.repo ?? undefined,
    branch: trigger?.branch,
    buildCommand: instance.buildCommand,
    startCommand: instance.startCommand,
    healthcheckPath: instance.healthcheckPath,
    watchPatterns: instance.watchPatterns,
    region: managesRegion ? (instance.region ?? undefined) : undefined,
    restartPolicyMaxRetries: instance.restartPolicyMaxRetries,
    restartPolicyType: instance.restartPolicyType,
    sleepApplication: instance.sleepApplication,
  });
};

const variablesFingerprint = (variables: Readonly<Record<string, string>>): string =>
  createHash("sha256")
    .update(
      JSON.stringify(
        Object.entries(variables).sort(([left], [right]) => left.localeCompare(right)),
      ),
    )
    .digest("hex");

const serviceInstanceMatches = (
  current: typeof ServiceInstance.Type,
  desired: DesiredBackend,
): boolean =>
  current.buildCommand === desired.buildCommand &&
  current.startCommand === desired.startCommand &&
  current.healthcheckPath === desired.healthcheckPath &&
  (desired.region === undefined || current.region === desired.region) &&
  current.restartPolicyType === "ON_FAILURE" &&
  current.restartPolicyMaxRetries === 10 &&
  current.sleepApplication === false &&
  current.watchPatterns.length === desired.watchPatterns.length &&
  desired.watchPatterns.every((pattern) => current.watchPatterns.includes(pattern));

const serviceSourceMatches = (
  current: typeof ServiceInstance.Type,
  desired: DesiredBackend,
  environmentId: string,
): boolean => {
  const trigger = current.service.repoTriggers.edges.find(
    ({ node }) => node.environmentId === environmentId,
  )?.node;
  return (
    trigger !== undefined &&
    current.source?.repo === desired.repository &&
    trigger.repository === desired.repository &&
    trigger.branch === desired.branch
  );
};

const variablesMatch = (
  current: Readonly<Record<string, string>>,
  desired: Readonly<Record<string, string>>,
): boolean => {
  const currentNames = Object.keys(current);
  const desiredNames = Object.keys(desired);
  return (
    currentNames.length === desiredNames.length &&
    desiredNames.every((name) => current[name] === desired[name])
  );
};

export interface RailwayApiService {
  readonly listManagedBackends: Effect.Effect<Array<BackendAttributes>, RailwayApiFailure>;
  readonly readBackend: (
    attributes: BackendAttributes,
  ) => Effect.Effect<BackendAttributes, RailwayApiFailure>;
  readonly reconcileBackend: (
    input: ReconcileInput,
  ) => Effect.Effect<BackendAttributes, RailwayApiFailure>;
  readonly deleteProject: (projectId: string) => Effect.Effect<void, RailwayApiFailure>;
  readonly orNotFound: <A>(
    effect: Effect.Effect<A, RailwayApiFailure>,
  ) => Effect.Effect<A | undefined, RailwayApiError>;
  readonly ignoreNotFound: (
    effect: Effect.Effect<void, RailwayApiFailure>,
  ) => Effect.Effect<void, RailwayApiError>;
}

export class RailwayApi extends Context.Service<RailwayApi, RailwayApiService>()(
  "@plakk/infra/railway/RailwayApi",
) {}

type Fetch = (input: string | URL | globalThis.Request, init?: RequestInit) => Promise<Response>;

export const makeRailwayApi = (
  execute: Fetch,
  credentials: Effect.Effect<Redacted.Redacted<string>, RailwayApiError>,
): RailwayApiService => {
  const graphql = Effect.fn("RailwayApi.graphql")(function* <A>(
    operation: string,
    query: string,
    variables: Record<string, unknown>,
    dataSchema: Schema.Codec<A, unknown, never, unknown>,
    notFoundResource?: string,
  ): Effect.fn.Return<A, RailwayApiFailure> {
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
      if (response.status === 404 && notFoundResource !== undefined) {
        return yield* new RailwayNotFoundError({
          operation,
          resource: notFoundResource,
        });
      }
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
      const notFound =
        notFoundResource !== undefined &&
        (firstError.extensions?.code === "NOT_FOUND" ||
          firstError.message.toLowerCase() === `${notFoundResource} not found`);
      if (notFound) {
        return yield* new RailwayNotFoundError({
          operation,
          resource: notFoundResource,
        });
      }
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
      "project",
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
      "project",
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
            restartPolicyMaxRetries
            restartPolicyType
            sleepApplication
            source {
              repo
            }
            watchPatterns
            service {
              repoTriggers {
                edges {
                  node {
                    branch
                    environmentId
                    repository
                  }
                }
              }
            }
          }
        }
      `,
      { serviceId, environmentId },
      Schema.Struct({ serviceInstance: ServiceInstance }),
      "service instance",
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
          replace: true,
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

  const getDeployment = (deploymentId: string) =>
    graphql(
      "deployment",
      `
        query deployment($id: String!) {
          deployment(id: $id) {
            id
            status
          }
        }
      `,
      { id: deploymentId },
      Schema.Struct({ deployment: Deployment }),
      "deployment",
    ).pipe(Effect.map(({ deployment }) => deployment));

  const waitForDeployment = Effect.fn("RailwayApi.waitForDeployment")(function* (
    deploymentId: string,
  ) {
    const observeDeployment = getDeployment(deploymentId).pipe(
      Effect.retry({
        while: (error) => error._tag === "RailwayNotFoundError",
        schedule: Schedule.spaced("1 second"),
        times: 30,
      }),
    );
    const deployment = yield* observeDeployment.pipe(
      Effect.repeat({
        schedule: Schedule.spaced("2 seconds"),
        until: ({ status }) =>
          !["BUILDING", "DEPLOYING", "INITIALIZING", "QUEUED"].includes(status),
      }),
      Effect.timeoutOrElse({
        duration: "15 minutes",
        orElse: () =>
          Effect.fail(
            new RailwayApiError({
              operation: "deployment",
              message: `Railway deployment '${deploymentId}' did not finish within 15 minutes`,
            }),
          ),
      }),
    );
    if (deployment.status !== "SUCCESS") {
      return yield* new RailwayApiError({
        operation: "deployment",
        message: `Railway deployment '${deploymentId}' finished with status ${deployment.status}`,
      });
    }
  });

  const deploy = Effect.fn("RailwayApi.deploy")(function* (
    serviceId: string,
    environmentId: string,
  ) {
    const deploymentId = yield* graphql(
      "serviceInstanceDeployV2",
      `
        mutation serviceInstanceDeployV2($serviceId: String!, $environmentId: String!) {
          serviceInstanceDeployV2(serviceId: $serviceId, environmentId: $environmentId)
        }
      `,
      { serviceId, environmentId },
      Schema.Struct({ serviceInstanceDeployV2: Schema.String }),
    ).pipe(Effect.map(({ serviceInstanceDeployV2 }) => serviceInstanceDeployV2));
    yield* waitForDeployment(deploymentId);
  });

  const observeBackend = Effect.fn("RailwayApi.observeBackend")(function* (
    project: typeof Project.Type,
    environment: typeof Environment.Type,
    service: typeof Service.Type,
    managesRegion: boolean,
  ) {
    const instance = yield* getServiceInstance(service.id, environment.id);
    const variables = yield* getVariables(project.id, environment.id, service.id);
    const domains = yield* getDomains(project.id, environment.id, service.id);
    const domain = domains.customDomains[0]?.domain ?? domains.serviceDomains[0]?.domain;
    if (domain === undefined) {
      return undefined;
    }
    return {
      projectId: project.id,
      environmentId: environment.id,
      serviceId: service.id,
      domain,
      url: `https://${domain}`,
      configuration: observedConfigurationOf(
        project.name,
        project.description,
        service.name,
        environment.id,
        instance,
        managesRegion,
      ),
      managesRegion,
      variablesFingerprint: variablesFingerprint(variables),
    };
  });

  const readBackend = Effect.fn("RailwayApi.readBackend")(function* (
    attributes: BackendAttributes,
  ) {
    const project = yield* getProject(attributes.projectId);
    const environment = project.environments.edges.find(
      ({ node }) => node.id === attributes.environmentId,
    )?.node;
    const service = project.services.edges.find(
      ({ node }) => node.id === attributes.serviceId,
    )?.node;
    if (environment === undefined || service === undefined) {
      return yield* new RailwayNotFoundError({
        operation: "readBackend",
        resource: "backend",
      });
    }
    const current = yield* observeBackend(project, environment, service, attributes.managesRegion);
    if (current === undefined) {
      return yield* new RailwayNotFoundError({
        operation: "readBackend",
        resource: "backend domain",
      });
    }
    return current;
  });

  const reconcileBackend = Effect.fn("RailwayApi.reconcileBackend")(function* ({
    desired,
    marker,
    previous,
  }: ReconcileInput) {
    const managesRegion = desired.region !== undefined;
    const configuration = configurationOf(desired, marker);
    let changed = previous?.configuration !== configuration;
    let project =
      previous === undefined
        ? undefined
        : yield* getProject(previous.projectId).pipe(
            Effect.catchTag("RailwayNotFoundError", () => Effect.void),
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

    const serviceInstance = yield* getServiceInstance(serviceId, environment.id).pipe(
      Effect.catchTag("RailwayNotFoundError", () => Effect.void),
    );
    if (
      serviceInstance === undefined ||
      !serviceSourceMatches(serviceInstance, desired, environment.id)
    ) {
      yield* connectService(serviceId, desired.repository, desired.branch);
      changed = true;
    }
    if (serviceInstance === undefined || !serviceInstanceMatches(serviceInstance, desired)) {
      yield* updateServiceInstance(serviceId, environment.id, desired);
      changed = true;
    }

    const currentVariables = yield* getVariables(project.id, environment.id, serviceId);
    if (!variablesMatch(currentVariables, desired.variables)) {
      yield* upsertVariables(project.id, environment.id, serviceId, desired.variables);
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
      managesRegion,
      variablesFingerprint: variablesFingerprint(desired.variables),
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
          return yield* new RailwayApiError({
            operation: "listManagedBackends",
            message: `Managed Railway project '${project.id}' is missing its environment or service`,
          });
        }
        const attributes = yield* observeBackend(project, environment, service, true);
        if (attributes === undefined) {
          return yield* new RailwayApiError({
            operation: "listManagedBackends",
            message: `Managed Railway project '${project.id}' has no backend domain`,
          });
        }
        return attributes;
      }),
    );
    return backends;
  });

  const orNotFound = <A>(effect: Effect.Effect<A, RailwayApiFailure>) =>
    effect.pipe(
      Effect.catchTag("RailwayNotFoundError", () => Effect.void.pipe(Effect.as(undefined))),
    );

  const ignoreNotFound = (
    effect: Effect.Effect<void, RailwayApiFailure>,
  ): Effect.Effect<void, RailwayApiError> =>
    effect.pipe(Effect.catchTag("RailwayNotFoundError", () => Effect.void));

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
