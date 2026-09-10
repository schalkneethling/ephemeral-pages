import { createRequire } from "node:module";

import { NetlifyAPI } from "netlify-cli/dist/index.js";
import { tryGetAgent } from "netlify-cli/dist/lib/http-agent.js";
import { USER_AGENT, getToken } from "netlify-cli/dist/utils/command-helpers.js";

const require = createRequire(import.meta.url);
const netlifyCliPackage = require("netlify-cli/package.json") as { version?: unknown };

const EXPECTED_NETLIFY_CLI_VERSION = "27.5.0";
const NETLIFY_API_SCHEME = "https";
const NETLIFY_API_HOST = "api.netlify.com";
const NETLIFY_API_PATH_PREFIX = "/api/v1";
const REQUEST_TIMEOUT_MS = 15_000;

export const NETLIFY_LOCAL_SECRET_KEYS = [
  "COLLABORATION_CAPABILITY_CURRENT_SECRET",
  "COLLABORATION_TICKET_SECRET",
  "COLLABORATION_SERVICE_TOKEN",
  "RATE_LIMIT_SECRET",
] as const;

export const STAGING_LOCAL_SECRET_KEYS = [
  "STAGE_COLLABORATION_CAPABILITY_CURRENT_SECRET",
  "STAGE_COLLABORATION_TICKET_SECRET",
  "STAGE_COLLABORATION_SERVICE_TOKEN",
  "STAGE_RATE_LIMIT_SECRET",
] as const;

type NetlifyLocalSecretKey = (typeof NETLIFY_LOCAL_SECRET_KEYS)[number];
type StagingLocalSecretKey = (typeof STAGING_LOCAL_SECRET_KEYS)[number];

export type StagingLocalSecretValues = Readonly<Record<StagingLocalSecretKey, string>>;

export type NetlifyLocalSecretsTarget = {
  siteId: string;
  accountId: string;
  siteName: string;
  productionSiteId: string;
};

type NetlifyRequestOptions = {
  redirect?: "error";
  signal?: AbortSignal;
};

type CreateEnvVarsParameters = {
  accountId: string;
  siteId: string;
  body: Array<{
    is_secret: true;
    key: NetlifyLocalSecretKey;
    scopes: Array<"builds" | "functions" | "runtime">;
    values: Array<{ context: "production"; value: string }>;
  }>;
};

export type NetlifyLocalSecretsClient = {
  createEnvVars: (
    params: CreateEnvVarsParameters,
    options?: NetlifyRequestOptions,
  ) => Promise<unknown>;
  getEnvVars: (
    params: { accountId: string; contextName?: "production"; siteId: string },
    options?: NetlifyRequestOptions,
  ) => Promise<unknown>;
  getSite: (params: { siteId: string }, options?: NetlifyRequestOptions) => Promise<unknown>;
};

export type LocalSecretsProvisionStage =
  | "configuration"
  | "authentication"
  | "target"
  | "preflight"
  | "mutation"
  | "postflight"
  | "complete";

export type LocalSecretsProvisionResult = {
  outcome: "passed" | "blocked";
  stage: LocalSecretsProvisionStage;
};

export class LocalSecretsMetadataError extends Error {
  constructor() {
    super("Netlify local-secret metadata request failed.");
    this.name = "LocalSecretsMetadataError";
  }
}

type JsonObject = Record<string, unknown>;

type Connection = {
  accessToken: string;
  agent?: unknown;
  host: string;
  pathPrefix: string;
  scheme: string;
  userAgent: string;
};

type AgentResolver = (url: URL) => unknown;

const isObject = (value: unknown): value is JsonObject =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const isNonEmptyString = (value: unknown): value is string =>
  typeof value === "string" && value.length > 0;

const hasExactKeys = (value: JsonObject, keys: readonly string[]): boolean => {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
};

const hasValidConfiguration = (
  target: NetlifyLocalSecretsTarget,
  values: StagingLocalSecretValues,
): boolean => {
  if (
    !isNonEmptyString(target.siteId) ||
    !isNonEmptyString(target.accountId) ||
    !isNonEmptyString(target.siteName) ||
    !isNonEmptyString(target.productionSiteId) ||
    target.siteId === target.productionSiteId ||
    !isObject(values) ||
    !hasExactKeys(values, STAGING_LOCAL_SECRET_KEYS)
  ) {
    return false;
  }

  const secrets = STAGING_LOCAL_SECRET_KEYS.map((key) => values[key]);
  return (
    secrets.every((secret) => typeof secret === "string" && secret.length >= 32) &&
    new Set(secrets).size === secrets.length
  );
};

const siteMatchesTarget = (site: unknown, target: NetlifyLocalSecretsTarget): boolean => {
  if (!isObject(site) || !isObject(site.build_settings)) return false;
  const settings = site.build_settings;
  return (
    site.id === target.siteId &&
    site.id !== target.productionSiteId &&
    site.account_id === target.accountId &&
    site.name === target.siteName &&
    site.ssl_url === `https://${target.siteName}.netlify.app` &&
    ["repo_url", "repo_path", "provider"].every(
      (key) => settings[key] == null || settings[key] === "",
    ) &&
    site.repo == null
  );
};

const readEnvironmentMetadata = (
  response: unknown,
): ReadonlyMap<
  string,
  { isSecret: boolean; scopes: readonly unknown[]; contexts: readonly unknown[] }
> | null => {
  if (!Array.isArray(response)) return null;

  const metadata = new Map<
    string,
    { isSecret: boolean; scopes: readonly unknown[]; contexts: readonly unknown[] }
  >();
  for (const variable of response) {
    if (
      !isObject(variable) ||
      !isNonEmptyString(variable.key) ||
      typeof variable.is_secret !== "boolean" ||
      !Array.isArray(variable.scopes) ||
      !Array.isArray(variable.values) ||
      metadata.has(variable.key)
    ) {
      return null;
    }
    const contexts = variable.values.map((entry) => (isObject(entry) ? entry.context : undefined));
    if (contexts.some((context) => typeof context !== "string")) return null;
    metadata.set(variable.key, {
      isSecret: variable.is_secret,
      scopes: variable.scopes,
      contexts,
    });
  }
  return metadata;
};

const hasExpectedSecretMetadata = (
  metadata: ReadonlyMap<
    string,
    { isSecret: boolean; scopes: readonly unknown[]; contexts: readonly unknown[] }
  >,
): boolean => {
  const expectedScopes = new Set(["builds", "functions", "runtime"]);
  return NETLIFY_LOCAL_SECRET_KEYS.every((key) => {
    const variable = metadata.get(key);
    return (
      variable?.isSecret === true &&
      variable.scopes.length === expectedScopes.size &&
      new Set(variable.scopes).size === expectedScopes.size &&
      variable.scopes.every((scope) => typeof scope === "string" && expectedScopes.has(scope)) &&
      variable.contexts.includes("production")
    );
  });
};

const mapSecretValues = (
  values: StagingLocalSecretValues,
): Record<NetlifyLocalSecretKey, string> => ({
  COLLABORATION_CAPABILITY_CURRENT_SECRET: values.STAGE_COLLABORATION_CAPABILITY_CURRENT_SECRET,
  COLLABORATION_TICKET_SECRET: values.STAGE_COLLABORATION_TICKET_SECRET,
  COLLABORATION_SERVICE_TOKEN: values.STAGE_COLLABORATION_SERVICE_TOKEN,
  RATE_LIMIT_SECRET: values.STAGE_RATE_LIMIT_SECRET,
});

export const createSingleDispatchAgent = (agent: unknown): AgentResolver => {
  let dispatched = false;
  return (url) => {
    if (dispatched) {
      const error = new Error("Additional Netlify request dispatch blocked.") as Error & {
        code?: string;
      };
      error.code = "NETLIFY_RETRY_BLOCKED";
      throw error;
    }
    dispatched = true;
    return typeof agent === "function" ? (agent as AgentResolver)(url) : agent;
  };
};

const createOneShotApi = (connection: Connection): NetlifyAPI =>
  new NetlifyAPI(connection.accessToken, {
    agent: createSingleDispatchAgent(connection.agent) as unknown as string,
    host: connection.host,
    pathPrefix: connection.pathPrefix,
    scheme: connection.scheme,
    userAgent: connection.userAgent,
  });

export const createOneShotNetlifyClient = (connection: Connection): NetlifyLocalSecretsClient => ({
  createEnvVars: (params, options) => createOneShotApi(connection).createEnvVars(params, options),
  getEnvVars: (params, options) => createOneShotApi(connection).getEnvVars(params, options),
  getSite: (params, options) => createOneShotApi(connection).getSite(params, options),
});

export const createAuthenticatedNetlifyLocalSecretsClient =
  async (): Promise<NetlifyLocalSecretsClient> => {
    try {
      if (netlifyCliPackage.version !== EXPECTED_NETLIFY_CLI_VERSION) {
        throw new LocalSecretsMetadataError();
      }
      const [accessToken] = await getToken();
      if (!accessToken) throw new LocalSecretsMetadataError();

      const proxy = await tryGetAgent({
        certificateFile: process.env.NETLIFY_PROXY_CERTIFICATE_FILENAME,
        httpProxy: process.env.HTTP_PROXY || process.env.HTTPS_PROXY,
      });
      if ("error" in proxy) throw new LocalSecretsMetadataError();

      return createOneShotNetlifyClient({
        accessToken,
        agent: "agent" in proxy ? proxy.agent : undefined,
        host: NETLIFY_API_HOST,
        pathPrefix: NETLIFY_API_PATH_PREFIX,
        scheme: NETLIFY_API_SCHEME,
        userAgent: USER_AGENT,
      });
    } catch {
      throw new LocalSecretsMetadataError();
    }
  };

export const safeProviderCall = async <T>(
  call: (signal: AbortSignal) => Promise<T>,
): Promise<T> => {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      call(controller.signal),
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => {
          controller.abort();
          reject(new LocalSecretsMetadataError());
        }, REQUEST_TIMEOUT_MS);
      }),
    ]);
  } catch {
    throw new LocalSecretsMetadataError();
  } finally {
    clearTimeout(timer);
  }
};

export const provisionNetlifyLocalSecrets = async (
  target: NetlifyLocalSecretsTarget,
  values: StagingLocalSecretValues,
  injectedClient?: NetlifyLocalSecretsClient,
): Promise<LocalSecretsProvisionResult> => {
  if (!hasValidConfiguration(target, values)) {
    return { outcome: "blocked", stage: "configuration" };
  }

  let client: NetlifyLocalSecretsClient;
  try {
    client = injectedClient ?? (await createAuthenticatedNetlifyLocalSecretsClient());
  } catch {
    return { outcome: "blocked", stage: "authentication" };
  }

  let site: unknown;
  try {
    site = await safeProviderCall((signal) =>
      client.getSite({ siteId: target.siteId }, { signal }),
    );
  } catch {
    return { outcome: "blocked", stage: "target" };
  }
  if (!siteMatchesTarget(site, target)) return { outcome: "blocked", stage: "target" };

  let before: ReturnType<typeof readEnvironmentMetadata>;
  try {
    const response = await safeProviderCall((signal) =>
      client.getEnvVars({ accountId: target.accountId, siteId: target.siteId }, { signal }),
    );
    before = readEnvironmentMetadata(response);
  } catch {
    return { outcome: "blocked", stage: "preflight" };
  }
  if (before === null || NETLIFY_LOCAL_SECRET_KEYS.some((key) => before?.has(key))) {
    return { outcome: "blocked", stage: "preflight" };
  }

  const mappedValues = mapSecretValues(values);
  const body = NETLIFY_LOCAL_SECRET_KEYS.map((key) => ({
    is_secret: true as const,
    key,
    scopes: ["builds", "functions", "runtime"] as Array<"builds" | "functions" | "runtime">,
    values: [{ context: "production" as const, value: mappedValues[key] }],
  }));
  try {
    await safeProviderCall((signal) =>
      client.createEnvVars(
        { accountId: target.accountId, body, siteId: target.siteId },
        { redirect: "error", signal },
      ),
    );
  } catch {
    return { outcome: "blocked", stage: "mutation" };
  }

  let after: ReturnType<typeof readEnvironmentMetadata>;
  try {
    const response = await safeProviderCall((signal) =>
      client.getEnvVars(
        { accountId: target.accountId, contextName: "production", siteId: target.siteId },
        { signal },
      ),
    );
    after = readEnvironmentMetadata(response);
  } catch {
    return { outcome: "blocked", stage: "postflight" };
  }
  if (after === null || !hasExpectedSecretMetadata(after)) {
    return { outcome: "blocked", stage: "postflight" };
  }

  return { outcome: "passed", stage: "complete" };
};
