# Plakk infrastructure

This package deploys the production backend as one Alchemy stack:

- a Neon project with the SQL migrations from `packages/db/drizzle`;
- three Axiom datasets for OTEL traces, logs, and metrics, plus one
  ingest-only API token;
- a Railway project containing the GitHub-backed `backend` service and a
  generated public domain.

The Railway integration is intentionally a small custom Alchemy provider. Its
single `Railway.Backend` resource owns the lifecycle needed by Plakk: project
and service creation, source connection, build/runtime settings, variables,
public domain, deployment, read/recovery, and deletion. It does not attempt to
model unrelated Railway products.

## Credentials

Copy `.env.example` to `.env` and fill in:

- `RAILWAY_API_TOKEN`: account or workspace token with project management
  access. A project token is too narrow because this stack creates the project.
- `NEON_API_KEY`: Neon API key capable of creating projects.
- `AXIOM_TOKEN`: Axiom management token capable of creating datasets and API
  tokens.
- `WORKOS_API_KEY` and `WORKOS_CLIENT_ID`: runtime credentials injected into
  the backend service.

`RAILWAY_WORKSPACE_ID` is optional. Without it, Railway creates the project in
the token owner's personal workspace. `RAILWAY_REPOSITORY` and
`RAILWAY_BRANCH` default to `peterjarian/plakk` and `main`.

Alchemy can also store Neon and Axiom credentials in a local profile via
`alchemy login`; environment variables are the non-interactive CI path.

## Deploy

From this directory:

```sh
alchemy deploy --stage production
```

Preview first with:

```sh
alchemy plan --stage production
```

Destroying the stack deletes the Alchemy-owned Railway project, Neon project,
Axiom datasets, and ingest token:

```sh
alchemy destroy --stage production
```

The stack currently uses Alchemy's local state under `.alchemy/`, which is
ignored by Git. Preserve that state between production deploys. Before moving
deploys into ephemeral CI runners, switch the stack to a shared remote Alchemy
state store.

## Runtime behavior

Railway builds only the backend workspace and watches the backend plus its
shared database/domain dependencies. Database migrations run through the Neon
resource before Railway receives `DATABASE_URL`.

The backend binds to `0.0.0.0:$PORT`, exposes `/health`, and exports Effect
traces, logs, and metrics over OTLP/HTTP. Each signal uses its own Axiom
dataset; metrics use Axiom's required `X-Axiom-Metrics-Dataset` header.
