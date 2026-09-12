import { unstable_readConfig } from "wrangler";

export type ProviderCommandRunner = (
  executable: string,
  args: readonly string[],
  env?: Record<string, string>,
) => Promise<string>;

export type ProviderVariableCheck = {
  present: boolean;
  matchesExpected: boolean;
};

export type NetlifyVariableScope = "builds" | "functions" | "runtime" | "post-processing";

export type NetlifyInspectionConfig = {
  siteId: string;
  accountId: string;
  expectedNonSecretVariables: Readonly<Record<string, string>>;
  requiredSecretNames: readonly string[];
  requiredVariableScopes: Readonly<Record<string, readonly NetlifyVariableScope[]>>;
};

export type NetlifySourceAttribution = {
  commitRef: string | null;
  branch: string | null;
  context: string | null;
};

export type NetlifyInspection = {
  siteId: string;
  publishedDeployId: string;
  publishLocked: boolean;
  publishedDeploySource: NetlifySourceAttribution;
  variableScopesMatch: boolean;
  nonSecretVariables: Readonly<Record<string, ProviderVariableCheck>>;
  requiredSecrets: Readonly<Record<string, boolean>>;
};

export type CloudflareInspectionConfig = {
  accountId: string;
  workerName: string;
  wranglerEnvironment: string;
  wranglerConfigPath: string;
  expectedNonSecretVariables: Readonly<Record<string, string>>;
  requiredSecretNames: readonly string[];
};

export type CloudflareTraffic = {
  versionId: string;
  percentage: number;
};

export type CloudflareInspection = {
  accountId: string;
  workerName: string;
  deploymentId: string;
  traffic: readonly CloudflareTraffic[];
  nonSecretVariables: Readonly<Record<string, ProviderVariableCheck>>;
  requiredSecrets: Readonly<Record<string, boolean>>;
};

type JsonObject = Record<string, unknown>;

type NetlifyEnvironmentVariable = {
  key: string;
  isSecret: boolean;
  scopes: readonly NetlifyVariableScope[];
  values: readonly JsonObject[];
};

type CloudflareBinding = {
  name: string;
  type: string;
  text?: string;
};

const NETLIFY_EXECUTABLE = "./node_modules/.bin/netlify";
const WRANGLER_EXECUTABLE = "./node_modules/.bin/wrangler";
const PERCENTAGE_EPSILON = 0.000_001;
const FULL_GIT_SHA = /^[0-9a-f]{40}$/i;
const NETLIFY_VARIABLE_SCOPES = new Set<NetlifyVariableScope>([
  "builds",
  "functions",
  "runtime",
  "post-processing",
]);

const normalizeNetlifyVariableScope = (value: unknown): NetlifyVariableScope | undefined => {
  if (value === "post_processing") return "post-processing";
  return typeof value === "string" && NETLIFY_VARIABLE_SCOPES.has(value as NetlifyVariableScope)
    ? (value as NetlifyVariableScope)
    : undefined;
};

const isObject = (value: unknown): value is JsonObject =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const isNonEmptyString = (value: unknown): value is string =>
  typeof value === "string" && value.length > 0;

const hasValidVariableConfig = (
  expected: Readonly<Record<string, string>>,
  requiredSecrets: readonly string[],
): boolean => {
  const expectedEntries = Object.entries(expected);
  return (
    expectedEntries.every(([key, value]) => key.length > 0 && typeof value === "string") &&
    requiredSecrets.every(isNonEmptyString) &&
    new Set(requiredSecrets).size === requiredSecrets.length
  );
};

const hasValidNetlifyScopeConfig = (config: NetlifyInspectionConfig): boolean => {
  const expectedNames = Object.keys(config.expectedNonSecretVariables);
  const secretNames = [...config.requiredSecretNames];
  const allNames = [...expectedNames, ...secretNames];
  if (new Set(allNames).size !== allNames.length) return false;

  const configuredNames = Object.keys(config.requiredVariableScopes);
  if (
    configuredNames.length !== allNames.length ||
    !configuredNames.every((name) => allNames.includes(name))
  ) {
    return false;
  }

  return Object.values(config.requiredVariableScopes).every(
    (scopes) =>
      scopes.length > 0 &&
      new Set(scopes).size === scopes.length &&
      scopes.every((scope) => NETLIFY_VARIABLE_SCOPES.has(scope)),
  );
};

const parseCommandJson = async (
  provider: "Netlify" | "Cloudflare",
  run: ProviderCommandRunner,
  executable: string,
  args: readonly string[],
  env?: Record<string, string>,
): Promise<unknown> => {
  let stdout: string;
  try {
    stdout = await run(executable, args, env);
  } catch {
    throw new Error(`${provider} inspection command failed.`);
  }

  try {
    return JSON.parse(stdout) as unknown;
  } catch {
    throw new Error(`${provider} inspection response is invalid.`);
  }
};

const invalidResponse = (provider: "Netlify" | "Cloudflare"): never => {
  throw new Error(`${provider} inspection response is invalid.`);
};

function assertValidResponse(
  condition: unknown,
  provider: "Netlify" | "Cloudflare",
): asserts condition {
  if (!condition) invalidResponse(provider);
}

const parseNetlifyEnvironment = (value: unknown): readonly NetlifyEnvironmentVariable[] => {
  assertValidResponse(Array.isArray(value), "Netlify");

  const environment: NetlifyEnvironmentVariable[] = [];
  for (const item of value) {
    assertValidResponse(
      isObject(item) &&
        isNonEmptyString(item.key) &&
        typeof item.is_secret === "boolean" &&
        Array.isArray(item.scopes) &&
        Array.isArray(item.values) &&
        item.values.every((entry) => isObject(entry) && isNonEmptyString(entry.context)),
      "Netlify",
    );
    const scopes = item.scopes.map(normalizeNetlifyVariableScope);
    assertValidResponse(
      scopes.every((scope): scope is NetlifyVariableScope => scope !== undefined) &&
        new Set(scopes).size === scopes.length,
      "Netlify",
    );
    environment.push({
      key: item.key,
      isSecret: item.is_secret,
      scopes,
      values: item.values,
    });
  }
  return environment;
};

const resolveNetlifyProductionValue = (
  variable: NetlifyEnvironmentVariable,
): string | undefined => {
  const productionValues = variable.values.filter((value) => value.context === "production");
  const allValues = variable.values.filter((value) => value.context === "all");
  const applicable = productionValues.length > 0 ? productionValues : allValues;

  if (applicable.length > 1) invalidResponse("Netlify");
  if (applicable.length === 0) return undefined;

  const value = applicable[0].value;
  assertValidResponse(typeof value === "string", "Netlify");
  return value;
};

const normalizeNetlifyLock = (value: unknown): boolean => {
  if (value === true) return true;
  if (value === false || value === null) return false;
  return invalidResponse("Netlify");
};

const inspectNetlifyVariables = (
  environment: readonly NetlifyEnvironmentVariable[],
  config: NetlifyInspectionConfig,
): {
  nonSecretVariables: Readonly<Record<string, ProviderVariableCheck>>;
  requiredSecrets: Readonly<Record<string, boolean>>;
  variableScopesMatch: boolean;
} => {
  const byKey = new Map<string, NetlifyEnvironmentVariable>();
  for (const variable of environment) {
    if (byKey.has(variable.key)) invalidResponse("Netlify");
    byKey.set(variable.key, variable);
  }

  const nonSecretVariables = Object.fromEntries(
    Object.entries(config.expectedNonSecretVariables).map(([key, expected]) => {
      const variable = byKey.get(key);
      if (!variable) return [key, { present: false, matchesExpected: false }];
      if (variable.isSecret) return [key, { present: true, matchesExpected: false }];

      const current = resolveNetlifyProductionValue(variable);
      return [key, { present: current !== undefined, matchesExpected: current === expected }];
    }),
  );
  const requiredSecrets = Object.fromEntries(
    config.requiredSecretNames.map((key) => {
      const variable = byKey.get(key);
      const hasProductionValue = variable?.values.some(
        (value) => value.context === "production" || value.context === "all",
      );
      return [key, variable?.isSecret === true && hasProductionValue === true];
    }),
  );

  const variableScopesMatch = Object.entries(config.requiredVariableScopes).every(
    ([key, requiredScopes]) => {
      const observedScopes = byKey.get(key)?.scopes;
      return (
        observedScopes !== undefined &&
        requiredScopes.every((requiredScope) => observedScopes.includes(requiredScope))
      );
    },
  );

  return { nonSecretVariables, requiredSecrets, variableScopesMatch };
};

export const inspectNetlify = async (
  config: NetlifyInspectionConfig,
  run: ProviderCommandRunner,
): Promise<NetlifyInspection> => {
  if (
    !isNonEmptyString(config.siteId) ||
    !isNonEmptyString(config.accountId) ||
    !hasValidVariableConfig(config.expectedNonSecretVariables, config.requiredSecretNames) ||
    !hasValidNetlifyScopeConfig(config)
  ) {
    throw new Error("Netlify inspection configuration is invalid.");
  }

  const site = await parseCommandJson("Netlify", run, NETLIFY_EXECUTABLE, [
    "api",
    "getSite",
    "--data",
    JSON.stringify({ site_id: config.siteId }),
  ]);
  assertValidResponse(
    isObject(site) && site.id === config.siteId && site.account_id === config.accountId,
    "Netlify",
  );

  const publishedDeploy = site.published_deploy;
  assertValidResponse(
    isObject(publishedDeploy) &&
      isNonEmptyString(publishedDeploy.id) &&
      publishedDeploy.state === "ready",
    "Netlify",
  );
  const publishedDeployLocked = normalizeNetlifyLock(publishedDeploy.locked);

  const deploy = await parseCommandJson("Netlify", run, NETLIFY_EXECUTABLE, [
    "api",
    "getSiteDeploy",
    "--data",
    JSON.stringify({ site_id: config.siteId, deploy_id: publishedDeploy.id }),
  ]);
  assertValidResponse(
    isObject(deploy) &&
      deploy.id === publishedDeploy.id &&
      deploy.site_id === config.siteId &&
      deploy.state === "ready",
    "Netlify",
  );
  const deployLocked = normalizeNetlifyLock(deploy.locked);
  assertValidResponse(deployLocked === publishedDeployLocked, "Netlify");
  for (const value of [deploy.commit_ref, deploy.branch, deploy.context]) {
    assertValidResponse(
      value === undefined || value === null || typeof value === "string",
      "Netlify",
    );
  }
  const publishedDeploySource: NetlifySourceAttribution = {
    commitRef:
      isNonEmptyString(deploy.commit_ref) && FULL_GIT_SHA.test(deploy.commit_ref)
        ? deploy.commit_ref
        : null,
    branch: isNonEmptyString(deploy.branch) ? deploy.branch : null,
    context: isNonEmptyString(deploy.context) ? deploy.context : null,
  };

  const environment = parseNetlifyEnvironment(
    await parseCommandJson("Netlify", run, NETLIFY_EXECUTABLE, [
      "api",
      "getEnvVars",
      "--data",
      JSON.stringify({
        account_id: config.accountId,
        site_id: config.siteId,
        context_name: "production",
      }),
    ]),
  );
  const variables = inspectNetlifyVariables(environment, config);

  return {
    siteId: config.siteId,
    publishedDeployId: publishedDeploy.id,
    publishLocked: publishedDeployLocked,
    publishedDeploySource,
    ...variables,
  };
};

const parseCloudflareTraffic = (value: unknown): readonly CloudflareTraffic[] => {
  assertValidResponse(Array.isArray(value) && value.length > 0, "Cloudflare");

  const traffic: CloudflareTraffic[] = value.map((item) => {
    assertValidResponse(
      isObject(item) &&
        isNonEmptyString(item.version_id) &&
        typeof item.percentage === "number" &&
        Number.isFinite(item.percentage) &&
        item.percentage > 0 &&
        item.percentage <= 100,
      "Cloudflare",
    );
    return { versionId: item.version_id, percentage: item.percentage };
  });

  if (
    new Set(traffic.map(({ versionId }) => versionId)).size !== traffic.length ||
    Math.abs(traffic.reduce((total, { percentage }) => total + percentage, 0) - 100) >
      PERCENTAGE_EPSILON
  ) {
    invalidResponse("Cloudflare");
  }
  return traffic;
};

const parseCloudflareBindings = (
  value: unknown,
  versionId: string,
): readonly CloudflareBinding[] => {
  assertValidResponse(
    isObject(value) && value.id === versionId && isObject(value.resources),
    "Cloudflare",
  );
  const rawBindings = value.resources.bindings;
  assertValidResponse(Array.isArray(rawBindings), "Cloudflare");

  const bindings: CloudflareBinding[] = [];
  for (const item of rawBindings) {
    assertValidResponse(
      isObject(item) && isNonEmptyString(item.name) && isNonEmptyString(item.type),
      "Cloudflare",
    );
    assertValidResponse(item.type !== "plain_text" || typeof item.text === "string", "Cloudflare");
    bindings.push({
      name: item.name,
      type: item.type,
      ...(typeof item.text === "string" ? { text: item.text } : {}),
    });
  }
  return bindings;
};

const parseCloudflareSecretNames = (value: unknown): ReadonlySet<string> => {
  assertValidResponse(Array.isArray(value), "Cloudflare");

  const names = new Set<string>();
  for (const item of value) {
    assertValidResponse(
      isObject(item) && isNonEmptyString(item.name) && item.type === "secret_text",
      "Cloudflare",
    );
    if (names.has(item.name)) invalidResponse("Cloudflare");
    names.add(item.name);
  }
  return names;
};

const inspectCloudflareVariables = (
  bindingsByVersion: readonly (readonly CloudflareBinding[])[],
  secretNames: ReadonlySet<string>,
  config: CloudflareInspectionConfig,
): {
  nonSecretVariables: Readonly<Record<string, ProviderVariableCheck>>;
  requiredSecrets: Readonly<Record<string, boolean>>;
} => {
  const bindingMaps = bindingsByVersion.map((bindings) => {
    const map = new Map<string, CloudflareBinding>();
    for (const binding of bindings) {
      if (map.has(binding.name)) invalidResponse("Cloudflare");
      map.set(binding.name, binding);
    }
    return map;
  });

  const nonSecretVariables = Object.fromEntries(
    Object.entries(config.expectedNonSecretVariables).map(([key, expected]) => {
      const current = bindingMaps.map((bindings) => bindings.get(key));
      const present = current.every((binding) => binding !== undefined);
      const matchesExpected = current.every(
        (binding) => binding?.type === "plain_text" && binding.text === expected,
      );
      return [key, { present, matchesExpected }];
    }),
  );
  const requiredSecrets = Object.fromEntries(
    config.requiredSecretNames.map((key) => [
      key,
      secretNames.has(key) &&
        bindingMaps.every((bindings) => bindings.get(key)?.type === "secret_text"),
    ]),
  );

  return { nonSecretVariables, requiredSecrets };
};

export const inspectCloudflare = async (
  config: CloudflareInspectionConfig,
  run: ProviderCommandRunner,
): Promise<CloudflareInspection> => {
  if (
    !isNonEmptyString(config.accountId) ||
    !isNonEmptyString(config.workerName) ||
    !isNonEmptyString(config.wranglerEnvironment) ||
    !isNonEmptyString(config.wranglerConfigPath) ||
    !hasValidVariableConfig(config.expectedNonSecretVariables, config.requiredSecretNames)
  ) {
    throw new Error("Cloudflare inspection configuration is invalid.");
  }

  try {
    const baseConfig = unstable_readConfig(
      { config: config.wranglerConfigPath },
      { hideWarnings: true },
    );
    const environmentConfig = unstable_readConfig(
      { config: config.wranglerConfigPath, env: config.wranglerEnvironment },
      { hideWarnings: true },
    );
    if (
      environmentConfig.name !== config.workerName ||
      (baseConfig.account_id !== undefined && baseConfig.account_id !== config.accountId) ||
      (environmentConfig.account_id !== undefined &&
        environmentConfig.account_id !== config.accountId)
    ) {
      throw new Error();
    }
  } catch {
    throw new Error("Cloudflare inspection configuration is invalid.");
  }

  const wranglerEnvironment = { CLOUDFLARE_ACCOUNT_ID: config.accountId };
  const commonArgs = [
    "--name",
    config.workerName,
    "--config",
    config.wranglerConfigPath,
    "--env",
    config.wranglerEnvironment,
  ] as const;
  const deployment = await parseCommandJson(
    "Cloudflare",
    run,
    WRANGLER_EXECUTABLE,
    ["deployments", "status", ...commonArgs, "--json"],
    wranglerEnvironment,
  );
  assertValidResponse(isObject(deployment) && isNonEmptyString(deployment.id), "Cloudflare");
  const traffic = parseCloudflareTraffic(deployment.versions);

  const bindingsByVersion: CloudflareBinding[][] = [];
  for (const { versionId } of traffic) {
    const version = await parseCommandJson(
      "Cloudflare",
      run,
      WRANGLER_EXECUTABLE,
      ["versions", "view", versionId, ...commonArgs, "--json"],
      wranglerEnvironment,
    );
    bindingsByVersion.push([...parseCloudflareBindings(version, versionId)]);
  }

  const secretNames = parseCloudflareSecretNames(
    await parseCommandJson(
      "Cloudflare",
      run,
      WRANGLER_EXECUTABLE,
      [
        "secret",
        "list",
        "--name",
        config.workerName,
        "--config",
        config.wranglerConfigPath,
        "--format",
        "json",
      ],
      wranglerEnvironment,
    ),
  );
  const variables = inspectCloudflareVariables(bindingsByVersion, secretNames, config);

  return {
    accountId: config.accountId,
    workerName: config.workerName,
    deploymentId: deployment.id,
    traffic,
    ...variables,
  };
};
