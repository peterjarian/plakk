import {
  PLAKK_PRODUCTION_AUTH_CALLBACK_URL,
  PLAKK_PRODUCTION_IDENTITIES,
} from "@plakk/shared/ProductionIdentities";

type Environment = Readonly<Record<string, string | undefined>>;

export type WebProductionConfiguration = {
  readonly apiOrigin: typeof PLAKK_PRODUCTION_IDENTITIES.api;
  readonly environment: string;
  readonly release: string;
  readonly webOrigin: typeof PLAKK_PRODUCTION_IDENTITIES.web;
  readonly workosRedirectUri: typeof PLAKK_PRODUCTION_AUTH_CALLBACK_URL;
};

export class InvalidWebProductionConfiguration extends Error {
  override readonly name = "InvalidWebProductionConfiguration";
  readonly issues: ReadonlyArray<string>;

  constructor(issues: ReadonlyArray<string>) {
    super(`Invalid Web production configuration:\n${issues.join("\n")}`);
    this.issues = issues;
  }
}

const required = (env: Environment, name: string, issues: Array<string>): string => {
  const value = env[name]?.trim();
  if (value === undefined || value === "") {
    issues.push(`${name} is required.`);
    return "";
  }
  return value;
};

export const validateWebProductionEnvironment = (env: Environment): WebProductionConfiguration => {
  const issues: Array<string> = [];
  const apiOrigin = required(env, "VITE_PLAKK_API_ORIGIN", issues);
  const environment = required(env, "VITE_PLAKK_ENVIRONMENT", issues);
  const release = required(env, "VITE_PLAKK_RELEASE", issues);
  const webOrigin = required(env, "PLAKK_WEB_ORIGIN", issues);
  const workosApiKey = required(env, "WORKOS_API_KEY", issues);
  const workosClientId = required(env, "WORKOS_CLIENT_ID", issues);
  const cookiePassword = required(env, "WORKOS_COOKIE_PASSWORD", issues);
  const workosRedirectUri = required(env, "WORKOS_REDIRECT_URI", issues);

  if (apiOrigin !== "" && apiOrigin !== PLAKK_PRODUCTION_IDENTITIES.api) {
    issues.push("VITE_PLAKK_API_ORIGIN must be the canonical production API origin.");
  }
  if (webOrigin !== "" && webOrigin !== PLAKK_PRODUCTION_IDENTITIES.web) {
    issues.push("PLAKK_WEB_ORIGIN must be the canonical production Web origin.");
  }
  if (workosRedirectUri !== "" && workosRedirectUri !== PLAKK_PRODUCTION_AUTH_CALLBACK_URL) {
    issues.push("WORKOS_REDIRECT_URI must be the canonical production AuthKit callback.");
  }
  if (workosApiKey !== "" && !workosApiKey.startsWith("sk_")) {
    issues.push("WORKOS_API_KEY has an invalid format.");
  }
  if (workosClientId !== "" && !workosClientId.startsWith("client_")) {
    issues.push("WORKOS_CLIENT_ID has an invalid format.");
  }
  if (cookiePassword !== "" && cookiePassword.length < 32) {
    issues.push("WORKOS_COOKIE_PASSWORD must contain at least 32 characters.");
  }
  if (env.WORKOS_COOKIE_DOMAIN?.trim()) {
    issues.push("WORKOS_COOKIE_DOMAIN must be unset so the session cookie remains host-only.");
  }
  const sameSite = env.WORKOS_COOKIE_SAME_SITE?.trim().toLowerCase();
  if (sameSite !== undefined && sameSite !== "" && sameSite !== "lax") {
    issues.push("WORKOS_COOKIE_SAME_SITE must be lax in production.");
  }

  if (issues.length > 0) throw new InvalidWebProductionConfiguration(issues);

  return {
    apiOrigin: apiOrigin as typeof PLAKK_PRODUCTION_IDENTITIES.api,
    environment,
    release,
    webOrigin: webOrigin as typeof PLAKK_PRODUCTION_IDENTITIES.web,
    workosRedirectUri: workosRedirectUri as typeof PLAKK_PRODUCTION_AUTH_CALLBACK_URL,
  };
};

export const validateWebProductionEnvironmentOnStartup = (): void => {
  if (process.env.NODE_ENV === "production") validateWebProductionEnvironment(process.env);
};
