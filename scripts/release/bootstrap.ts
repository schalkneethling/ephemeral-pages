import { createHash } from "node:crypto";

import type { NetlifyVariableScope, ProviderCommandRunner } from "./providers.ts";

// Minimum runtime scopes to verify, not an instruction to restrict write scopes.
// Provision all scopes so bootstrap also works on Netlify plans without scope selection.
export const NETLIFY_STAGING_VARIABLE_POLICY = {
  PUBLIC_BASE_URL: ["functions"],
  COLLABORATION_SERVICE_URL: ["functions"],
  COLLABORATION_WEBSOCKET_URL: ["builds", "functions"],
  COLLABORATION_TICKET_AUDIENCE: ["functions"],
  COLLABORATION_CAPABILITY_CURRENT_VERSION: ["functions"],
  COLLABORATION_ENABLED: ["functions"],
} as const satisfies Readonly<Record<string, readonly NetlifyVariableScope[]>>;

export type NetlifyStagingVariableName = keyof typeof NETLIFY_STAGING_VARIABLE_POLICY;

export type NetlifyStagingBootstrapInput = {
  accountId: string;
  accountSlug: string;
  productionSiteId: string;
  siteName: string;
  nonSecretVariables: Readonly<Record<NetlifyStagingVariableName, string>>;
};

export type NetlifyStagingBootstrapCheckpoint = {
  schemaVersion: 1;
  inputFingerprint: string;
  phase:
    | "pending-site-creation"
    | "site-created"
    | "pending-non-secret-configuration"
    | "awaiting-operator-secrets";
  siteId: string | null;
};

export type NetlifyStagingBootstrapStore = {
  load(): Promise<NetlifyStagingBootstrapCheckpoint | null>;
  save(checkpoint: NetlifyStagingBootstrapCheckpoint): Promise<void>;
};

export type NetlifyStagingBootstrapDependencies = {
  run: ProviderCommandRunner;
  store: NetlifyStagingBootstrapStore;
};

export type NetlifyStagingBootstrapResult = {
  status: "awaiting-operator-secrets";
  accountId: string;
  siteId: string;
  siteName: string;
  inputFingerprint: string;
};

type JsonObject = Record<string, unknown>;

const NETLIFY_EXECUTABLE = "./node_modules/.bin/netlify";
const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,255}$/u;
const SITE_NAME = /^[A-Za-z0-9-]{1,63}$/u;
const VARIABLE_NAME = /^[A-Z][A-Z0-9_]*$/u;
const NETLIFY_ALL_SCOPES = [
  "builds",
  "functions",
  "runtime",
  "post-processing",
] as const satisfies readonly NetlifyVariableScope[];
const NETLIFY_SCOPES = new Set<NetlifyVariableScope>(NETLIFY_ALL_SCOPES);

export class StagingBootstrapError extends Error {
  readonly kind: "blocked" | "invalid-input" | "operation" | "state";

  constructor(kind: StagingBootstrapError["kind"]) {
    const messages = {
      blocked: "Staging bootstrap is blocked pending operator inspection.",
      "invalid-input": "Staging bootstrap input is invalid.",
      operation: "Staging bootstrap operation did not complete.",
      state: "Staging bootstrap checkpoint is invalid.",
    } as const;
    super(messages[kind]);
    this.name = "StagingBootstrapError";
    this.kind = kind;
  }
}

const isObject = (value: unknown): value is JsonObject =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const isNonEmptyString = (value: unknown): value is string =>
  typeof value === "string" && value.length > 0;

const normalizeScope = (value: unknown): NetlifyVariableScope | undefined => {
  if (value === "post_processing") return "post-processing";
  return typeof value === "string" && NETLIFY_SCOPES.has(value as NetlifyVariableScope)
    ? (value as NetlifyVariableScope)
    : undefined;
};

const stableValue = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(stableValue);
  if (isObject(value)) {
    return Object.fromEntries(
      Object.entries(value)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, item]) => [key, stableValue(item)]),
    );
  }
  return value;
};

export const stagingBootstrapFingerprint = (input: NetlifyStagingBootstrapInput): string =>
  createHash("sha256")
    .update(JSON.stringify(stableValue(input)))
    .digest("hex");

const validateInput = (input: NetlifyStagingBootstrapInput): void => {
  const entries = Object.entries(input.nonSecretVariables);
  const permittedNames = Object.keys(NETLIFY_STAGING_VARIABLE_POLICY);
  if (
    !IDENTIFIER.test(input.accountId) ||
    !IDENTIFIER.test(input.productionSiteId) ||
    !SITE_NAME.test(input.accountSlug) ||
    !SITE_NAME.test(input.siteName) ||
    entries.length !== permittedNames.length ||
    entries.some(([name]) => !permittedNames.includes(name)) ||
    entries.some(
      ([name, value]) =>
        !VARIABLE_NAME.test(name) ||
        typeof value !== "string" ||
        value.length === 0 ||
        value.length > 2_048,
    )
  ) {
    throw new StagingBootstrapError("invalid-input");
  }
  if (input.nonSecretVariables.PUBLIC_BASE_URL !== `https://${input.siteName}.netlify.app`) {
    throw new StagingBootstrapError("invalid-input");
  }
};

const isCheckpoint = (value: unknown): value is NetlifyStagingBootstrapCheckpoint =>
  isObject(value) &&
  value.schemaVersion === 1 &&
  typeof value.inputFingerprint === "string" &&
  [
    "pending-site-creation",
    "site-created",
    "pending-non-secret-configuration",
    "awaiting-operator-secrets",
  ].includes(value.phase as string) &&
  (value.siteId === null || (typeof value.siteId === "string" && IDENTIFIER.test(value.siteId))) &&
  (value.phase === "pending-site-creation" ? value.siteId === null : value.siteId !== null);

const loadCheckpoint = async (
  store: NetlifyStagingBootstrapStore,
  inputFingerprint: string,
): Promise<NetlifyStagingBootstrapCheckpoint | null> => {
  let checkpoint: NetlifyStagingBootstrapCheckpoint | null;
  try {
    checkpoint = await store.load();
  } catch {
    throw new StagingBootstrapError("state");
  }
  if (
    checkpoint !== null &&
    (!isCheckpoint(checkpoint) || checkpoint.inputFingerprint !== inputFingerprint)
  ) {
    throw new StagingBootstrapError("state");
  }
  return checkpoint;
};

const saveCheckpoint = async (
  store: NetlifyStagingBootstrapStore,
  checkpoint: NetlifyStagingBootstrapCheckpoint,
): Promise<void> => {
  try {
    await store.save(checkpoint);
  } catch {
    throw new StagingBootstrapError("state");
  }
};

const runJson = async (run: ProviderCommandRunner, args: readonly string[]): Promise<unknown> => {
  let output: string;
  try {
    output = await run(NETLIFY_EXECUTABLE, args);
  } catch {
    throw new StagingBootstrapError("operation");
  }
  try {
    return JSON.parse(output) as unknown;
  } catch {
    throw new StagingBootstrapError("operation");
  }
};

const assertSiteIdentity = (
  value: unknown,
  input: NetlifyStagingBootstrapInput,
  expectedSiteId: string | undefined,
  expectedSiteName: string | undefined,
  requireStagingSettings: boolean,
): string => {
  if (
    !isObject(value) ||
    !isNonEmptyString(value.id) ||
    !IDENTIFIER.test(value.id) ||
    !isNonEmptyString(value.name) ||
    (expectedSiteName !== undefined && value.name !== expectedSiteName) ||
    value.account_id !== input.accountId ||
    value.account_slug !== input.accountSlug ||
    (expectedSiteId !== undefined && value.id !== expectedSiteId) ||
    (requireStagingSettings &&
      (value.ssl_url !== input.nonSecretVariables.PUBLIC_BASE_URL ||
        !isObject(value.build_settings) ||
        ["repo_url", "repo_path", "provider"].some(
          (key) =>
            value.build_settings &&
            (value.build_settings as JsonObject)[key] != null &&
            (value.build_settings as JsonObject)[key] !== "",
        ) ||
        value.repo != null))
  ) {
    throw new StagingBootstrapError("operation");
  }
  return value.id;
};

const getSite = async (
  siteId: string,
  input: NetlifyStagingBootstrapInput,
  run: ProviderCommandRunner,
  expectedSiteName: string | undefined,
  requireStagingSettings: boolean,
): Promise<JsonObject> => {
  const response = await runJson(run, [
    "api",
    "getSite",
    "--data",
    JSON.stringify({ site_id: siteId }),
  ]);
  assertSiteIdentity(response, input, siteId, expectedSiteName, requireStagingSettings);
  return response as JsonObject;
};

const assertDistinctFromProduction = async (
  input: NetlifyStagingBootstrapInput,
  run: ProviderCommandRunner,
): Promise<void> => {
  const production = await getSite(input.productionSiteId, input, run, undefined, false);
  if (production.name === input.siteName) {
    throw new StagingBootstrapError("invalid-input");
  }
};

const createSite = async (
  input: NetlifyStagingBootstrapInput,
  dependencies: NetlifyStagingBootstrapDependencies,
  inputFingerprint: string,
): Promise<NetlifyStagingBootstrapCheckpoint> => {
  await saveCheckpoint(dependencies.store, {
    schemaVersion: 1,
    inputFingerprint,
    phase: "pending-site-creation",
    siteId: null,
  });
  const response = await runJson(dependencies.run, [
    "api",
    "createSiteInTeam",
    "--data",
    JSON.stringify({
      account_slug: input.accountSlug,
      body: {
        name: input.siteName,
      },
    }),
  ]);
  const checkpoint: NetlifyStagingBootstrapCheckpoint = {
    schemaVersion: 1,
    inputFingerprint,
    phase: "site-created",
    siteId: assertSiteIdentity(response, input, undefined, input.siteName, true),
  };
  if (checkpoint.siteId === input.productionSiteId) {
    throw new StagingBootstrapError("operation");
  }
  await saveCheckpoint(dependencies.store, checkpoint);
  return checkpoint;
};

const sortedVariables = (input: NetlifyStagingBootstrapInput) =>
  Object.entries(input.nonSecretVariables).sort(([left], [right]) => left.localeCompare(right));

const assertVariablesConfigured = (value: unknown, input: NetlifyStagingBootstrapInput): void => {
  if (!Array.isArray(value)) throw new StagingBootstrapError("operation");
  const byKey = new Map<string, JsonObject>();
  for (const item of value) {
    if (!isObject(item) || !isNonEmptyString(item.key) || byKey.has(item.key)) {
      throw new StagingBootstrapError("operation");
    }
    byKey.set(item.key, item);
  }
  for (const [key, expected] of sortedVariables(input)) {
    const item = byKey.get(key);
    if (!item || item.is_secret !== false || !Array.isArray(item.scopes)) {
      throw new StagingBootstrapError("operation");
    }
    const scopes = item.scopes.map(normalizeScope);
    if (
      scopes.some((scope) => scope === undefined) ||
      NETLIFY_STAGING_VARIABLE_POLICY[key as NetlifyStagingVariableName].some(
        (scope) => !scopes.includes(scope),
      ) ||
      !Array.isArray(item.values) ||
      !item.values.some(
        (entry) => isObject(entry) && entry.context === "production" && entry.value === expected,
      )
    ) {
      throw new StagingBootstrapError("operation");
    }
  }
};

const configureNonSecretVariables = async (
  input: NetlifyStagingBootstrapInput,
  dependencies: NetlifyStagingBootstrapDependencies,
  checkpoint: NetlifyStagingBootstrapCheckpoint & { siteId: string },
): Promise<NetlifyStagingBootstrapCheckpoint & { siteId: string }> => {
  const pending: NetlifyStagingBootstrapCheckpoint & { siteId: string } = {
    ...checkpoint,
    phase: "pending-non-secret-configuration",
  };
  await saveCheckpoint(dependencies.store, pending);
  const response = await runJson(dependencies.run, [
    "api",
    "createEnvVars",
    "--data",
    JSON.stringify({
      account_id: input.accountId,
      site_id: checkpoint.siteId,
      body: sortedVariables(input).map(([key, value]) => ({
        key,
        is_secret: false,
        scopes: NETLIFY_ALL_SCOPES.map((scope) =>
          scope === "post-processing" ? "post_processing" : scope,
        ),
        values: [{ context: "production", value }],
      })),
    }),
  ]);
  assertVariablesConfigured(response, input);
  const complete: NetlifyStagingBootstrapCheckpoint & { siteId: string } = {
    ...pending,
    phase: "awaiting-operator-secrets",
  };
  await saveCheckpoint(dependencies.store, complete);
  return complete;
};

const resultFromCheckpoint = (
  input: NetlifyStagingBootstrapInput,
  checkpoint: NetlifyStagingBootstrapCheckpoint & { siteId: string },
): NetlifyStagingBootstrapResult => ({
  status: "awaiting-operator-secrets",
  accountId: input.accountId,
  siteId: checkpoint.siteId,
  siteName: input.siteName,
  inputFingerprint: checkpoint.inputFingerprint,
});

export async function bootstrapNetlifyStaging(
  input: NetlifyStagingBootstrapInput,
  dependencies: NetlifyStagingBootstrapDependencies,
): Promise<NetlifyStagingBootstrapResult> {
  validateInput(input);
  const inputFingerprint = stagingBootstrapFingerprint(input);
  let checkpoint = await loadCheckpoint(dependencies.store, inputFingerprint);
  if (checkpoint?.siteId === input.productionSiteId) throw new StagingBootstrapError("state");
  if (
    checkpoint?.phase === "pending-site-creation" ||
    checkpoint?.phase === "pending-non-secret-configuration"
  ) {
    throw new StagingBootstrapError("blocked");
  }
  await assertDistinctFromProduction(input, dependencies.run);
  checkpoint ??= await createSite(input, dependencies, inputFingerprint);
  if (checkpoint.siteId === null) throw new StagingBootstrapError("state");
  const siteId = checkpoint.siteId;
  if (checkpoint.phase === "site-created") {
    await getSite(siteId, input, dependencies.run, input.siteName, true);
    checkpoint = await configureNonSecretVariables(input, dependencies, {
      ...checkpoint,
      siteId,
    });
  }
  return resultFromCheckpoint(input, { ...checkpoint, siteId });
}

export async function recoverPendingNetlifySite(
  input: NetlifyStagingBootstrapInput,
  siteId: string,
  dependencies: NetlifyStagingBootstrapDependencies,
): Promise<void> {
  validateInput(input);
  if (!IDENTIFIER.test(siteId)) throw new StagingBootstrapError("invalid-input");
  const inputFingerprint = stagingBootstrapFingerprint(input);
  const checkpoint = await loadCheckpoint(dependencies.store, inputFingerprint);
  if (checkpoint?.phase !== "pending-site-creation") {
    throw new StagingBootstrapError("state");
  }
  await assertDistinctFromProduction(input, dependencies.run);
  await getSite(siteId, input, dependencies.run, input.siteName, true);
  await saveCheckpoint(dependencies.store, {
    schemaVersion: 1,
    inputFingerprint,
    phase: "site-created",
    siteId,
  });
}

export async function recoverPendingNetlifyVariables(
  input: NetlifyStagingBootstrapInput,
  dependencies: NetlifyStagingBootstrapDependencies,
): Promise<"site-created" | "awaiting-operator-secrets"> {
  validateInput(input);
  const inputFingerprint = stagingBootstrapFingerprint(input);
  const checkpoint = await loadCheckpoint(dependencies.store, inputFingerprint);
  if (checkpoint?.phase !== "pending-non-secret-configuration" || checkpoint.siteId === null) {
    throw new StagingBootstrapError("state");
  }
  await assertDistinctFromProduction(input, dependencies.run);
  await getSite(checkpoint.siteId, input, dependencies.run, input.siteName, true);
  const response = await runJson(dependencies.run, [
    "api",
    "getEnvVars",
    "--data",
    JSON.stringify({
      account_id: input.accountId,
      site_id: checkpoint.siteId,
    }),
  ]);
  if (!Array.isArray(response)) throw new StagingBootstrapError("operation");
  const names = response.map((entry) => (isObject(entry) ? entry.key : undefined));
  if (names.some((name) => typeof name !== "string") || new Set(names).size !== names.length) {
    throw new StagingBootstrapError("operation");
  }
  if (names.every((name) => !Object.hasOwn(input.nonSecretVariables, name as string))) {
    await saveCheckpoint(dependencies.store, { ...checkpoint, phase: "site-created" });
    return "site-created";
  }
  assertVariablesConfigured(response, input);
  await saveCheckpoint(dependencies.store, {
    ...checkpoint,
    phase: "awaiting-operator-secrets",
  });
  return "awaiting-operator-secrets";
}
