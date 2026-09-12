import { unstable_readConfig } from "wrangler";
import { z } from "zod/v4";

const providerInspectionOperationSchema = z.enum([
  "configuration",
  "getSite",
  "getSiteDeploy",
  "getEnvVars",
  "deploymentsStatus",
  "versionView",
  "secretList",
  "expectedPair",
]);
const providerInspectionAssertionSchema = z.enum([
  "configuration",
  "site-identity",
  "published-deploy-ready",
  "published-lock-shape",
  "deploy-identity-ready",
  "deploy-lock-shape",
  "deploy-lock-match",
  "deploy-source-shape",
  "environment-shape",
  "environment-entry",
  "environment-scopes",
  "environment-duplicate",
  "deployment-identity",
  "traffic-shape",
  "traffic-entry",
  "traffic-total",
  "version-identity",
  "bindings-shape",
  "binding-entry",
  "binding-duplicate",
  "secrets-shape",
  "secret-entry",
  "secret-duplicate",
  "provider-policy",
  "observation-deadline",
]);

export const providerInspectionDiagnosticSchema = z
  .strictObject({
    provider: z.enum(["netlify", "cloudflare", "pair"]),
    operation: providerInspectionOperationSchema,
    classification: z.enum(["command", "json", "assertion", "mismatch"]),
    assertion: providerInspectionAssertionSchema.optional(),
    commandKind: z.enum(["failed", "spawn", "timeout", "output-limit"]).optional(),
    exitCode: z.number().int().min(0).max(255).nullable().optional(),
  })
  .superRefine((value, context) => {
    const validOperation =
      (value.provider === "netlify" &&
        ["configuration", "getSite", "getSiteDeploy", "getEnvVars"].includes(value.operation)) ||
      (value.provider === "cloudflare" &&
        ["configuration", "deploymentsStatus", "versionView", "secretList"].includes(
          value.operation,
        )) ||
      (value.provider === "pair" && value.operation === "expectedPair");
    const validDetails =
      (value.classification === "command" &&
        value.commandKind !== undefined &&
        value.assertion === undefined &&
        (value.commandKind === "failed"
          ? value.exitCode !== undefined
          : value.exitCode === undefined)) ||
      (value.classification === "assertion" &&
        value.assertion !== undefined &&
        value.commandKind === undefined &&
        value.exitCode === undefined) ||
      ((value.classification === "json" || value.classification === "mismatch") &&
        value.assertion === undefined &&
        value.commandKind === undefined &&
        value.exitCode === undefined);
    if (
      !validOperation ||
      !validDetails ||
      (value.classification === "mismatch" && value.provider !== "pair") ||
      (value.provider === "pair" && !["mismatch", "assertion"].includes(value.classification))
    ) {
      context.addIssue({ code: "custom", message: "Provider inspection diagnostic is invalid." });
    }
  });
export type ProviderInspectionDiagnostic = z.infer<typeof providerInspectionDiagnosticSchema>;

export class ProviderInspectionError extends Error {
  readonly kind = "failed";
  readonly diagnostic: ProviderInspectionDiagnostic;

  constructor(diagnostic: ProviderInspectionDiagnostic, cause?: unknown) {
    const provider = diagnostic.provider === "netlify" ? "Netlify" : "Cloudflare";
    const message =
      diagnostic.provider === "pair"
        ? "Provider inspection failed."
        : diagnostic.operation === "configuration"
          ? `${provider} inspection configuration is invalid.`
          : diagnostic.classification === "command"
            ? `${provider} inspection command failed.`
            : `${provider} inspection response is invalid.`;
    super(message, cause instanceof Error ? { cause } : undefined);
    this.name = "ProviderInspectionError";
    this.diagnostic = providerInspectionDiagnosticSchema.parse(diagnostic);
  }
}

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
  provider: "netlify" | "cloudflare",
  operation: ProviderInspectionDiagnostic["operation"],
  run: ProviderCommandRunner,
  executable: string,
  args: readonly string[],
  env?: Record<string, string>,
): Promise<unknown> => {
  let stdout: string;
  try {
    stdout = await run(executable, args, env);
  } catch (error) {
    if (error instanceof ProviderInspectionError) throw error;
    const kind =
      typeof error === "object" &&
      error !== null &&
      "kind" in error &&
      ["failed", "spawn", "timeout", "output-limit"].includes(String(error.kind))
        ? (error.kind as "failed" | "spawn" | "timeout" | "output-limit")
        : "failed";
    throw new ProviderInspectionError(
      {
        provider,
        operation,
        classification: "command",
        commandKind: kind,
        ...(kind === "failed" ? { exitCode: null } : {}),
      },
      error,
    );
  }

  try {
    return JSON.parse(stdout) as unknown;
  } catch (error) {
    throw new ProviderInspectionError({ provider, operation, classification: "json" }, error);
  }
};

const invalidResponse = (
  provider: "netlify" | "cloudflare",
  operation: ProviderInspectionDiagnostic["operation"],
  assertion: NonNullable<ProviderInspectionDiagnostic["assertion"]>,
): never => {
  throw new ProviderInspectionError({
    provider,
    operation,
    classification: "assertion",
    assertion,
  });
};

function assertValidResponse(
  condition: unknown,
  provider: "netlify" | "cloudflare",
  operation: ProviderInspectionDiagnostic["operation"],
  assertion: NonNullable<ProviderInspectionDiagnostic["assertion"]>,
): asserts condition {
  if (!condition) invalidResponse(provider, operation, assertion);
}

const parseNetlifyEnvironment = (value: unknown): readonly NetlifyEnvironmentVariable[] => {
  assertValidResponse(Array.isArray(value), "netlify", "getEnvVars", "environment-shape");

  const environment: NetlifyEnvironmentVariable[] = [];
  for (const item of value) {
    assertValidResponse(
      isObject(item) &&
        isNonEmptyString(item.key) &&
        typeof item.is_secret === "boolean" &&
        Array.isArray(item.scopes) &&
        Array.isArray(item.values) &&
        item.values.every((entry) => isObject(entry) && isNonEmptyString(entry.context)),
      "netlify",
      "getEnvVars",
      "environment-entry",
    );
    const scopes = item.scopes.map(normalizeNetlifyVariableScope);
    assertValidResponse(
      scopes.every((scope): scope is NetlifyVariableScope => scope !== undefined) &&
        new Set(scopes).size === scopes.length,
      "netlify",
      "getEnvVars",
      "environment-scopes",
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

  if (applicable.length > 1) invalidResponse("netlify", "getEnvVars", "environment-entry");
  if (applicable.length === 0) return undefined;

  const value = applicable[0].value;
  assertValidResponse(typeof value === "string", "netlify", "getEnvVars", "environment-entry");
  return value;
};

const normalizeNetlifyLock = (value: unknown, operation: "getSite" | "getSiteDeploy"): boolean => {
  if (value === true) return true;
  if (value === false || value === null) return false;
  return invalidResponse(
    "netlify",
    operation,
    operation === "getSite" ? "published-lock-shape" : "deploy-lock-shape",
  );
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
    if (byKey.has(variable.key)) invalidResponse("netlify", "getEnvVars", "environment-duplicate");
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
    throw new ProviderInspectionError({
      provider: "netlify",
      operation: "configuration",
      classification: "assertion",
      assertion: "configuration",
    });
  }

  const site = await parseCommandJson("netlify", "getSite", run, NETLIFY_EXECUTABLE, [
    "api",
    "getSite",
    "--data",
    JSON.stringify({ site_id: config.siteId }),
  ]);
  assertValidResponse(
    isObject(site) && site.id === config.siteId && site.account_id === config.accountId,
    "netlify",
    "getSite",
    "site-identity",
  );

  const publishedDeploy = site.published_deploy;
  assertValidResponse(
    isObject(publishedDeploy) &&
      isNonEmptyString(publishedDeploy.id) &&
      publishedDeploy.state === "ready",
    "netlify",
    "getSite",
    "published-deploy-ready",
  );
  const publishedDeployLocked = normalizeNetlifyLock(publishedDeploy.locked, "getSite");

  const deploy = await parseCommandJson("netlify", "getSiteDeploy", run, NETLIFY_EXECUTABLE, [
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
    "netlify",
    "getSiteDeploy",
    "deploy-identity-ready",
  );
  const deployLocked = normalizeNetlifyLock(deploy.locked, "getSiteDeploy");
  assertValidResponse(
    deployLocked === publishedDeployLocked,
    "netlify",
    "getSiteDeploy",
    "deploy-lock-match",
  );
  for (const value of [deploy.commit_ref, deploy.branch, deploy.context]) {
    assertValidResponse(
      value === undefined || value === null || typeof value === "string",
      "netlify",
      "getSiteDeploy",
      "deploy-source-shape",
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
    await parseCommandJson("netlify", "getEnvVars", run, NETLIFY_EXECUTABLE, [
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
  assertValidResponse(
    Array.isArray(value) && value.length > 0,
    "cloudflare",
    "deploymentsStatus",
    "traffic-shape",
  );

  const traffic: CloudflareTraffic[] = value.map((item) => {
    assertValidResponse(
      isObject(item) &&
        isNonEmptyString(item.version_id) &&
        typeof item.percentage === "number" &&
        Number.isFinite(item.percentage) &&
        item.percentage > 0 &&
        item.percentage <= 100,
      "cloudflare",
      "deploymentsStatus",
      "traffic-entry",
    );
    return { versionId: item.version_id, percentage: item.percentage };
  });

  if (
    new Set(traffic.map(({ versionId }) => versionId)).size !== traffic.length ||
    Math.abs(traffic.reduce((total, { percentage }) => total + percentage, 0) - 100) >
      PERCENTAGE_EPSILON
  ) {
    invalidResponse("cloudflare", "deploymentsStatus", "traffic-total");
  }
  return traffic;
};

const parseCloudflareBindings = (
  value: unknown,
  versionId: string,
): readonly CloudflareBinding[] => {
  assertValidResponse(
    isObject(value) && value.id === versionId && isObject(value.resources),
    "cloudflare",
    "versionView",
    "version-identity",
  );
  const rawBindings = value.resources.bindings;
  assertValidResponse(Array.isArray(rawBindings), "cloudflare", "versionView", "bindings-shape");

  const bindings: CloudflareBinding[] = [];
  for (const item of rawBindings) {
    assertValidResponse(
      isObject(item) && isNonEmptyString(item.name) && isNonEmptyString(item.type),
      "cloudflare",
      "versionView",
      "binding-entry",
    );
    assertValidResponse(
      item.type !== "plain_text" || typeof item.text === "string",
      "cloudflare",
      "versionView",
      "binding-entry",
    );
    bindings.push({
      name: item.name,
      type: item.type,
      ...(typeof item.text === "string" ? { text: item.text } : {}),
    });
  }
  return bindings;
};

const parseCloudflareSecretNames = (value: unknown): ReadonlySet<string> => {
  assertValidResponse(Array.isArray(value), "cloudflare", "secretList", "secrets-shape");

  const names = new Set<string>();
  for (const item of value) {
    assertValidResponse(
      isObject(item) && isNonEmptyString(item.name) && item.type === "secret_text",
      "cloudflare",
      "secretList",
      "secret-entry",
    );
    if (names.has(item.name)) invalidResponse("cloudflare", "secretList", "secret-duplicate");
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
      if (map.has(binding.name)) invalidResponse("cloudflare", "versionView", "binding-duplicate");
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
    throw new ProviderInspectionError({
      provider: "cloudflare",
      operation: "configuration",
      classification: "assertion",
      assertion: "configuration",
    });
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
  } catch (error) {
    if (error instanceof ProviderInspectionError) throw error;
    throw new ProviderInspectionError(
      {
        provider: "cloudflare",
        operation: "configuration",
        classification: "assertion",
        assertion: "configuration",
      },
      error,
    );
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
    "cloudflare",
    "deploymentsStatus",
    run,
    WRANGLER_EXECUTABLE,
    ["deployments", "status", ...commonArgs, "--json"],
    wranglerEnvironment,
  );
  assertValidResponse(
    isObject(deployment) && isNonEmptyString(deployment.id),
    "cloudflare",
    "deploymentsStatus",
    "deployment-identity",
  );
  const traffic = parseCloudflareTraffic(deployment.versions);

  const bindingsByVersion: CloudflareBinding[][] = [];
  for (const { versionId } of traffic) {
    const version = await parseCommandJson(
      "cloudflare",
      "versionView",
      run,
      WRANGLER_EXECUTABLE,
      ["versions", "view", versionId, ...commonArgs, "--json"],
      wranglerEnvironment,
    );
    bindingsByVersion.push([...parseCloudflareBindings(version, versionId)]);
  }

  const secretNames = parseCloudflareSecretNames(
    await parseCommandJson(
      "cloudflare",
      "secretList",
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
