#!/usr/bin/env node

import { execFile, spawn, type ChildProcess } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { createServer } from "node:net";
import { delimiter, dirname, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseEnv } from "node:util";

const WEB_PORT = 3000;
const BACKEND_PORT = 3100;
const STARTUP_TIMEOUT_MS = 30_000;
const SHUTDOWN_GRACE_MS = 1_500;
const LOOPBACK_HOST = "127.0.0.1";

type JsonRecord = Record<string, unknown>;
type EnvironmentSource = Readonly<Record<string, string | undefined>>;

const DEVELOPER_ENVIRONMENT_KEYS = [
  "DATABASE_URL",
  "WORKOS_API_KEY",
  "WORKOS_CLIENT_ID",
  "WORKOS_COOKIE_PASSWORD",
] as const;

export interface DeveloperEnvironment {
  readonly DATABASE_URL: string;
  readonly WORKOS_API_KEY: string;
  readonly WORKOS_CLIENT_ID: string;
  readonly WORKOS_COOKIE_PASSWORD: string;
  readonly PLAKK_DESKTOP_USER_DATA_PATH?: string;
}

export interface ApplicationEnvironments {
  readonly web: Readonly<Record<string, string>>;
  readonly backend: Readonly<Record<string, string>>;
  readonly desktop: Readonly<Record<string, string>>;
}

export interface TailscaleIdentity {
  readonly dnsName: string;
}

export interface DevelopmentTopology {
  readonly webOrigin: string;
  readonly backendOrigin: string;
  readonly rpcUrl: string;
  readonly webEnvironment: Readonly<Record<string, string>>;
  readonly backendEnvironment: Readonly<Record<string, string>>;
  readonly desktopEnvironment: Readonly<Record<string, string>>;
}

export type ServeRouteState =
  | { readonly type: "ready" }
  | { readonly type: "missing" }
  | { readonly type: "conflict"; readonly proxy: string | null };

export function resolveDeveloperEnvironment(
  sources: ReadonlyArray<EnvironmentSource>,
): DeveloperEnvironment {
  const read = (key: string): string | undefined => {
    for (const source of sources) {
      const value = source[key];
      if (value !== undefined && value.trim().length > 0) return value;
    }
    return undefined;
  };

  const missing = DEVELOPER_ENVIRONMENT_KEYS.filter((key) => read(key) === undefined);
  if (missing.length > 0) {
    throw new Error(
      `Missing developer environment variables: ${missing.join(", ")}. Copy .env.example to .env.local and fill in the required values.`,
    );
  }

  const cookiePassword = read("WORKOS_COOKIE_PASSWORD")!;
  if (cookiePassword.length < 32) {
    throw new Error("WORKOS_COOKIE_PASSWORD must contain at least 32 characters.");
  }
  const desktopUserDataPath = read("PLAKK_DESKTOP_USER_DATA_PATH");

  return {
    DATABASE_URL: read("DATABASE_URL")!,
    WORKOS_API_KEY: read("WORKOS_API_KEY")!,
    WORKOS_CLIENT_ID: read("WORKOS_CLIENT_ID")!,
    WORKOS_COOKIE_PASSWORD: cookiePassword,
    ...(desktopUserDataPath ? { PLAKK_DESKTOP_USER_DATA_PATH: desktopUserDataPath } : {}),
  };
}

export function resolveApplicationEnvironments(
  developer: DeveloperEnvironment,
  topology: DevelopmentTopology,
): ApplicationEnvironments {
  return {
    web: {
      WORKOS_API_KEY: developer.WORKOS_API_KEY,
      WORKOS_CLIENT_ID: developer.WORKOS_CLIENT_ID,
      WORKOS_COOKIE_PASSWORD: developer.WORKOS_COOKIE_PASSWORD,
      ...topology.webEnvironment,
    },
    backend: {
      DATABASE_URL: developer.DATABASE_URL,
      WORKOS_API_KEY: developer.WORKOS_API_KEY,
      WORKOS_CLIENT_ID: developer.WORKOS_CLIENT_ID,
      ...topology.backendEnvironment,
    },
    desktop: {
      WORKOS_CLIENT_ID: developer.WORKOS_CLIENT_ID,
      ...(developer.PLAKK_DESKTOP_USER_DATA_PATH
        ? { PLAKK_DESKTOP_USER_DATA_PATH: developer.PLAKK_DESKTOP_USER_DATA_PATH }
        : {}),
      ...topology.desktopEnvironment,
    },
  };
}

interface ProcessExit {
  readonly code: number | null;
  readonly signal: NodeJS.Signals | null;
  readonly error?: Error;
}

interface ManagedProcess {
  readonly name: string;
  readonly child: ChildProcess;
  readonly exit: Promise<ProcessExit>;
}

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseJson(raw: string, description: string): JsonRecord {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch (cause) {
    throw new Error(`Could not parse ${description} as JSON.`, { cause });
  }
  if (!isRecord(value)) {
    throw new Error(`${description} did not contain a JSON object.`);
  }
  return value;
}

export function parseTailscaleIdentity(rawStatus: string): TailscaleIdentity {
  const status = parseJson(rawStatus, "Tailscale status");
  if (status.BackendState !== "Running") {
    const backendState = typeof status.BackendState === "string" ? status.BackendState : "unknown";
    throw new Error(`Tailscale is not connected (backend state: ${backendState}).`);
  }

  const self = status.Self;
  if (!isRecord(self) || self.Online !== true) {
    throw new Error("This device is not online in Tailscale.");
  }

  const rawDnsName = self.DNSName;
  if (typeof rawDnsName !== "string") {
    throw new Error("Tailscale did not report a MagicDNS name for this device.");
  }

  const dnsName = rawDnsName.trim().replace(/\.$/u, "");
  if (dnsName.length === 0) {
    throw new Error("Tailscale reported an empty MagicDNS name for this device.");
  }

  return { dnsName };
}

export function resolveDevelopmentTopology(dnsName: string): DevelopmentTopology {
  const webOrigin = new URL(`https://${dnsName}`).origin;
  const backendUrl = new URL(`https://${dnsName}`);
  backendUrl.port = String(BACKEND_PORT);
  const backendOrigin = backendUrl.origin;
  const rpcUrl = new URL("/api/rpc", backendOrigin).toString();

  return {
    webOrigin,
    backendOrigin,
    rpcUrl,
    webEnvironment: {
      WORKOS_REDIRECT_URI: new URL("/api/auth/callback", webOrigin).toString(),
      VITE_PLAKK_RPC_URL: rpcUrl,
    },
    backendEnvironment: {
      PLAKK_BACKEND_HOST: LOOPBACK_HOST,
      PLAKK_WEB_ORIGIN: webOrigin,
      PORT: String(BACKEND_PORT),
    },
    desktopEnvironment: {
      PLAKK_RPC_URL: rpcUrl,
      WORKOS_REDIRECT_URI: new URL("/auth/desktop/callback", webOrigin).toString(),
    },
  };
}

export function inspectServeRoute(
  rawStatus: string,
  input: {
    readonly dnsName: string;
    readonly httpsPort: number;
    readonly target: string;
  },
): ServeRouteState {
  const status = parseJson(rawStatus, "Tailscale Serve status");
  const web = status.Web;
  if (web === undefined) return { type: "missing" };
  if (!isRecord(web)) {
    throw new Error("Tailscale Serve status contains an invalid Web configuration.");
  }

  const endpoint = web[`${input.dnsName}:${input.httpsPort}`];
  if (endpoint === undefined) return { type: "missing" };
  if (!isRecord(endpoint)) {
    return { type: "conflict", proxy: null };
  }

  const handlers = endpoint.Handlers;
  if (!isRecord(handlers)) {
    return { type: "conflict", proxy: null };
  }

  const rootHandler = handlers["/"];
  if (!isRecord(rootHandler)) {
    return { type: "conflict", proxy: null };
  }

  const proxy = typeof rootHandler.Proxy === "string" ? rootHandler.Proxy : null;
  return proxy === input.target ? { type: "ready" } : { type: "conflict", proxy };
}

function commandOutput(command: string, args: ReadonlyArray<string>): Promise<string> {
  return new Promise((resolveOutput, reject) => {
    execFile(
      command,
      args,
      {
        encoding: "utf8",
        maxBuffer: 4 * 1024 * 1024,
        timeout: 10_000,
      },
      (error, stdout, stderr) => {
        if (error) {
          reject(
            new Error(
              `${command} ${args.join(" ")} failed${stderr.trim() ? `: ${stderr.trim()}` : "."}`,
              { cause: error },
            ),
          );
          return;
        }
        resolveOutput(stdout);
      },
    );
  });
}

function runCommand(command: string, args: ReadonlyArray<string>): Promise<void> {
  return new Promise((resolveCommand, reject) => {
    const child = spawn(command, args, { stdio: "inherit" });
    child.once("error", (cause) => {
      reject(new Error(`Could not start ${command}.`, { cause }));
    });
    child.once("exit", (code, signal) => {
      if (code === 0) {
        resolveCommand();
        return;
      }
      reject(
        new Error(
          `${command} ${args.join(" ")} exited with ${signal ? `signal ${signal}` : `code ${String(code)}`}.`,
        ),
      );
    });
  });
}

function tailscaleCommand(): string {
  return process.platform === "win32" ? "tailscale.exe" : "tailscale";
}

function readEnvironmentFile(path: string): EnvironmentSource {
  return existsSync(path) ? parseEnv(readFileSync(path, "utf8")) : {};
}

function loadDeveloperEnvironment(repoRoot: string): DeveloperEnvironment {
  const rootEnvironment = readEnvironmentFile(resolve(repoRoot, ".env"));
  const localEnvironment = readEnvironmentFile(resolve(repoRoot, ".env.local"));
  const legacyEnvironments = [
    readEnvironmentFile(resolve(repoRoot, "apps/web/.env")),
    readEnvironmentFile(resolve(repoRoot, "apps/backend/.env")),
    readEnvironmentFile(resolve(repoRoot, "apps/desktop/.env")),
    readEnvironmentFile(resolve(repoRoot, "packages/db/.env")),
  ];
  const canonicalSources = [process.env, localEnvironment, rootEnvironment];
  const usesLegacyEnvironment = DEVELOPER_ENVIRONMENT_KEYS.some(
    (key) =>
      canonicalSources.every((source) => {
        const value = source[key];
        return value === undefined || value.trim().length === 0;
      }) &&
      legacyEnvironments.some((source) => {
        const value = source[key];
        return value !== undefined && value.trim().length > 0;
      }),
  );

  if (usesLegacyEnvironment) {
    process.stdout.write(
      "ⓘ Using values from legacy app-local .env files. Move them to root .env.local.\n",
    );
  }

  return resolveDeveloperEnvironment([...canonicalSources, ...legacyEnvironments]);
}

async function readServeStatus(): Promise<string> {
  try {
    return await commandOutput(tailscaleCommand(), ["serve", "status", "--json"]);
  } catch (cause) {
    if (cause instanceof Error && cause.message.includes("no serve config")) return "{}";
    throw cause;
  }
}

async function ensureServeRoute(input: {
  readonly label: string;
  readonly dnsName: string;
  readonly httpsPort: number;
  readonly target: string;
}): Promise<void> {
  const route = inspectServeRoute(await readServeStatus(), input);
  if (route.type === "ready") {
    process.stdout.write(`✓ ${input.label} HTTPS route already configured\n`);
    return;
  }
  if (route.type === "conflict") {
    throw new Error(
      `Tailscale Serve port ${input.httpsPort} is already configured for ${
        route.proxy ?? "a non-proxy handler"
      }; refusing to replace it with ${input.target}.`,
    );
  }

  await runCommand(tailscaleCommand(), [
    "serve",
    "--bg",
    `--https=${input.httpsPort}`,
    input.target,
  ]);

  const configured = inspectServeRoute(await readServeStatus(), input);
  if (configured.type !== "ready") {
    throw new Error(`Tailscale did not retain the ${input.label} HTTPS route.`);
  }
  process.stdout.write(`✓ ${input.label} HTTPS route configured\n`);
}

function assertPortAvailable(port: number): Promise<void> {
  return new Promise((resolvePort, reject) => {
    const server = createServer();
    server.unref();
    server.once("error", (cause) => {
      reject(new Error(`Port ${port} is already in use on ${LOOPBACK_HOST}.`, { cause }));
    });
    server.listen(port, LOOPBACK_HOST, () => {
      server.close((cause) => {
        if (cause) {
          reject(new Error(`Could not release port ${port}.`, { cause }));
          return;
        }
        resolvePort();
      });
    });
  });
}

function spawnProcess(input: {
  readonly name: string;
  readonly command: string;
  readonly args: ReadonlyArray<string>;
  readonly cwd: string;
  readonly environment?: Readonly<Record<string, string>>;
}): ManagedProcess {
  const detached = process.platform !== "win32";
  const child = spawn(input.command, input.args, {
    cwd: input.cwd,
    detached,
    env: {
      ...process.env,
      PATH: [resolve(input.cwd, "node_modules/.bin"), process.env.PATH]
        .filter((value) => value !== undefined && value.length > 0)
        .join(delimiter),
      ...input.environment,
    },
    stdio: "inherit",
  });
  const exit = new Promise<ProcessExit>((resolveExit) => {
    let settled = false;
    const settle = (event: ProcessExit) => {
      if (settled) return;
      settled = true;
      resolveExit(event);
    };
    child.once("error", (error) => {
      settle({ code: null, signal: null, error });
    });
    child.once("exit", (code, signal) => {
      settle({ code, signal });
    });
  });
  return { name: input.name, child, exit };
}

function signalProcess(managed: ManagedProcess, signal: NodeJS.Signals): void {
  if (managed.child.exitCode !== null) return;
  if (process.platform === "win32" || managed.child.pid === undefined) {
    managed.child.kill(signal);
    return;
  }

  try {
    process.kill(-managed.child.pid, signal);
  } catch (cause) {
    if (typeof cause === "object" && cause !== null && "code" in cause && cause.code === "ESRCH") {
      return;
    }
    throw cause;
  }
}

async function waitForHttp(input: {
  readonly name: string;
  readonly url: string;
  readonly process?: ManagedProcess;
}): Promise<void> {
  const startedAt = performance.now();
  while (performance.now() - startedAt < STARTUP_TIMEOUT_MS) {
    const probe = fetch(input.url, {
      redirect: "manual",
      signal: AbortSignal.timeout(1_000),
    })
      .then((response) => response.status < 500)
      .catch(() => false);
    const result = input.process
      ? await Promise.race([
          probe.then((ready) => ({ type: "probe" as const, ready })),
          input.process.exit.then((exit) => ({ type: "exit" as const, exit })),
        ])
      : { type: "probe" as const, ready: await probe };

    if (result.type === "exit") {
      throw new Error(`${input.process?.name ?? input.name} exited before becoming ready.`);
    }
    if (result.ready) return;
    await delay(250);
  }
  throw new Error(`${input.name} did not become ready at ${input.url} within 30 seconds.`);
}

function formatExit(managed: ManagedProcess, exit: ProcessExit): string {
  if (exit.error) return `${managed.name} failed to start: ${exit.error.message}`;
  if (exit.signal) return `${managed.name} exited from signal ${exit.signal}.`;
  return `${managed.name} exited with code ${String(exit.code)}.`;
}

async function stopProcesses(processes: ReadonlyArray<ManagedProcess>): Promise<void> {
  for (const managed of processes) {
    signalProcess(managed, "SIGTERM");
  }

  const allExited = Promise.all(processes.map((managed) => managed.exit));
  const completed = await Promise.race([
    allExited.then(() => true),
    delay(SHUTDOWN_GRACE_MS).then(() => false),
  ]);
  if (completed) return;

  for (const managed of processes) {
    signalProcess(managed, "SIGKILL");
  }
  await Promise.all(processes.map((managed) => managed.exit));
}

async function runDevelopment(): Promise<void> {
  const scriptDir = dirname(fileURLToPath(import.meta.url));
  const repoRoot = resolve(scriptDir, "..");
  const developerEnvironment = loadDeveloperEnvironment(repoRoot);
  const tailscaleStatus = await commandOutput(tailscaleCommand(), ["status", "--json"]);
  const identity = parseTailscaleIdentity(tailscaleStatus);
  const topology = resolveDevelopmentTopology(identity.dnsName);
  const applicationEnvironments = resolveApplicationEnvironments(developerEnvironment, topology);

  process.stdout.write(
    [
      "",
      "Plakk development",
      "",
      `✓ Tailscale connected as ${identity.dnsName}`,
      "",
      "Development topology",
      `  web       ${topology.webOrigin}`,
      `  backend   ${topology.backendOrigin}`,
      `  rpc       ${topology.rpcUrl}`,
      "",
    ].join("\n"),
  );

  await Promise.all([assertPortAvailable(WEB_PORT), assertPortAvailable(BACKEND_PORT)]);

  await ensureServeRoute({
    label: "web",
    dnsName: identity.dnsName,
    httpsPort: 443,
    target: `http://${LOOPBACK_HOST}:${WEB_PORT}`,
  });
  await ensureServeRoute({
    label: "backend",
    dnsName: identity.dnsName,
    httpsPort: BACKEND_PORT,
    target: `http://${LOOPBACK_HOST}:${BACKEND_PORT}`,
  });

  const processes: ManagedProcess[] = [];
  let receivedSignal: NodeJS.Signals | null = null;
  const signal = new Promise<NodeJS.Signals>((resolveSignal) => {
    for (const name of ["SIGINT", "SIGTERM"] as const) {
      process.once(name, () => {
        receivedSignal = name;
        resolveSignal(name);
      });
    }
  });

  try {
    const backend = spawnProcess({
      name: "backend",
      command: process.execPath,
      args: ["--experimental-strip-types", "--watch", "src/main.ts"],
      cwd: resolve(repoRoot, "apps/backend"),
      environment: applicationEnvironments.backend,
    });
    const web = spawnProcess({
      name: "web",
      command: "vp",
      args: ["dev", "--port", String(WEB_PORT), "--host", LOOPBACK_HOST],
      cwd: resolve(repoRoot, "apps/web"),
      environment: applicationEnvironments.web,
    });
    processes.push(backend, web);

    await Promise.race([
      Promise.all([
        waitForHttp({
          name: "backend",
          url: `http://${LOOPBACK_HOST}:${BACKEND_PORT}/health`,
          process: backend,
        }),
        waitForHttp({
          name: "web",
          url: `http://${LOOPBACK_HOST}:${WEB_PORT}`,
          process: web,
        }),
      ]),
      signal,
    ]);
    if (receivedSignal) return;

    await Promise.all([
      waitForHttp({ name: "Tailnet backend", url: `${topology.backendOrigin}/health` }),
      waitForHttp({ name: "Tailnet web", url: topology.webOrigin }),
    ]);

    const desktop = spawnProcess({
      name: "desktop",
      command: process.execPath,
      args: ["scripts/with-electron-native.mjs", "node", "scripts/dev-electron.mjs"],
      cwd: resolve(repoRoot, "apps/desktop"),
      environment: applicationEnvironments.desktop,
    });
    processes.push(desktop);

    process.stdout.write(
      [
        "",
        "✓ backend ready",
        "✓ web ready",
        "✓ Tailnet HTTPS ready",
        "✓ desktop started",
        "",
        "Development is ready. Press Ctrl+C to stop.",
        "",
      ].join("\n"),
    );

    const outcome = await Promise.race([
      signal.then((name) => ({ type: "signal" as const, name })),
      backend.exit.then((exit) => ({ type: "exit" as const, managed: backend, exit })),
      web.exit.then((exit) => ({ type: "exit" as const, managed: web, exit })),
      desktop.exit.then((exit) => ({ type: "exit" as const, managed: desktop, exit })),
    ]);
    if (outcome.type === "exit") throw new Error(formatExit(outcome.managed, outcome.exit));
  } finally {
    await stopProcesses(processes);
  }
}

async function main(): Promise<void> {
  try {
    await runDevelopment();
  } catch (cause) {
    const message = cause instanceof Error ? cause.message : String(cause);
    process.stderr.write(`\nPlakk development failed: ${message}\n`);
    process.exitCode = 1;
  }
}

const invokedPath = process.argv[1];
if (invokedPath && import.meta.url === pathToFileURL(resolve(invokedPath)).href) {
  void main();
}
