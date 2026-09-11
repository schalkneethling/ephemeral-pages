import { createHash } from "node:crypto";

import { unstable_readConfig } from "wrangler";

export type WorkerBootstrapCommandResult = {
  exitCode: number | null;
  stdout: string;
  stderr: string;
};

export type WorkerBootstrapCommandRunner = (
  executable: string,
  args: readonly string[],
  env: Readonly<Record<string, string>>,
) => Promise<WorkerBootstrapCommandResult>;

export type WorkerBootstrapInput = {
  accountId: string;
  workerName: string;
  productionWorkerName: string;
  wranglerEnvironment: "staging";
  wranglerConfigPath: string;
  expectedNonSecretVariables: Readonly<{
    ALLOWED_ORIGINS: string;
    PAGE_CONTENT_ORIGIN: string;
    PUBLIC_WORKER_ORIGIN: string;
    TICKET_AUDIENCE: string;
  }>;
};

type WorkerBootstrapCheckpointBase = {
  schemaVersion: 1;
  inputFingerprint: string;
};

export type WorkerBootstrapCheckpoint =
  | (WorkerBootstrapCheckpointBase & {
      phase: "pending-worker-deployment";
      versionId: null;
      deploymentId: null;
    })
  | (WorkerBootstrapCheckpointBase & {
      phase: "version-returned";
      versionId: string;
      deploymentId: null;
    })
  | (WorkerBootstrapCheckpointBase & {
      phase: "complete";
      versionId: string;
      deploymentId: string;
    });

type CompleteWorkerBootstrapCheckpoint = Extract<WorkerBootstrapCheckpoint, { phase: "complete" }>;

export type WorkerBootstrapStore = {
  load(): Promise<WorkerBootstrapCheckpoint | null>;
  save(checkpoint: WorkerBootstrapCheckpoint): Promise<void>;
};

export type WorkerBootstrapDependencies = {
  run: WorkerBootstrapCommandRunner;
  store: WorkerBootstrapStore;
  withSecretsFile<T>(operation: (path: string) => Promise<T>): Promise<T>;
};

export type WorkerBootstrapResult = {
  status: "complete";
  accountId: string;
  workerName: string;
  versionId: string;
  deploymentId: string;
  inputFingerprint: string;
};

type JsonObject = Record<string, unknown>;

const WRANGLER_EXECUTABLE = "./node_modules/.bin/wrangler";
const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,255}$/u;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;
const REQUIRED_SECRETS = ["TICKET_HMAC_SECRET", "ADMIN_TOKEN"] as const;
const EXPECTED_BINDING_NAMES = [
  "ALLOWED_ORIGINS",
  "PAGE_CONTENT_ORIGIN",
  "PUBLIC_WORKER_ORIGIN",
  "TICKET_AUDIENCE",
] as const;

export class WorkerBootstrapError extends Error {
  readonly kind:
    | "absence-unverified"
    | "blocked"
    | "configuration"
    | "existing-worker"
    | "invalid-input"
    | "operation"
    | "state";

  constructor(kind: WorkerBootstrapError["kind"]) {
    const messages = {
      "absence-unverified": "Worker absence was not confirmed by Wrangler error code 10007.",
      blocked: "Worker bootstrap is blocked pending operator inspection.",
      configuration: "Worker bootstrap configuration is invalid.",
      "existing-worker": "Worker bootstrap target already exists.",
      "invalid-input": "Worker bootstrap input is invalid.",
      operation: "Worker bootstrap operation did not complete.",
      state: "Worker bootstrap checkpoint is invalid.",
    } as const;
    super(messages[kind]);
    this.name = "WorkerBootstrapError";
    this.kind = kind;
  }
}

const isObject = (value: unknown): value is JsonObject =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const isUuid = (value: unknown): value is string => typeof value === "string" && UUID.test(value);

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

export const workerBootstrapFingerprint = (input: WorkerBootstrapInput): string =>
  createHash("sha256")
    .update(JSON.stringify(stableValue(input)))
    .digest("hex");

const isHttpsOrigin = (value: string): boolean => {
  try {
    const url = new URL(value);
    return url.protocol === "https:" && url.origin === value;
  } catch {
    return false;
  }
};

const validateInput = (input: WorkerBootstrapInput): void => {
  const variables = Object.entries(input.expectedNonSecretVariables);
  if (
    !IDENTIFIER.test(input.accountId) ||
    !IDENTIFIER.test(input.workerName) ||
    !IDENTIFIER.test(input.productionWorkerName) ||
    input.workerName === input.productionWorkerName ||
    input.wranglerEnvironment !== "staging" ||
    input.wranglerConfigPath.length === 0 ||
    variables.length !== EXPECTED_BINDING_NAMES.length ||
    variables.some(
      ([name, value]) =>
        !EXPECTED_BINDING_NAMES.includes(name as (typeof EXPECTED_BINDING_NAMES)[number]) ||
        typeof value !== "string" ||
        value.length === 0 ||
        value.length > 2_048,
    ) ||
    input.expectedNonSecretVariables.ALLOWED_ORIGINS !==
      input.expectedNonSecretVariables.PAGE_CONTENT_ORIGIN ||
    input.expectedNonSecretVariables.TICKET_AUDIENCE !== input.workerName ||
    !isHttpsOrigin(input.expectedNonSecretVariables.ALLOWED_ORIGINS) ||
    !isHttpsOrigin(input.expectedNonSecretVariables.PUBLIC_WORKER_ORIGIN) ||
    !new URL(input.expectedNonSecretVariables.PUBLIC_WORKER_ORIGIN).hostname.startsWith(
      `${input.workerName}.`,
    )
  ) {
    throw new WorkerBootstrapError("invalid-input");
  }
};

const exactStringArray = (value: unknown, expected: readonly string[]): boolean =>
  Array.isArray(value) &&
  value.length === expected.length &&
  value.every((item, index) => item === expected[index]);

const accountMatches = (value: JsonObject, accountId: string): boolean =>
  value.account_id === undefined || value.account_id === accountId;

const validateWranglerConfig = (input: WorkerBootstrapInput): void => {
  try {
    const base = unstable_readConfig(
      { config: input.wranglerConfigPath },
      { hideWarnings: true },
    ) as unknown;
    const production = unstable_readConfig(
      { config: input.wranglerConfigPath, env: "production" },
      { hideWarnings: true },
    ) as unknown;
    const staging = unstable_readConfig(
      { config: input.wranglerConfigPath, env: input.wranglerEnvironment },
      { hideWarnings: true },
    ) as unknown;
    if (!isObject(base) || !isObject(production) || !isObject(staging)) throw new Error();

    const variables = staging.vars;
    const secrets = staging.secrets;
    const durableObjects = staging.durable_objects;
    const browser = staging.browser;
    const migrations = staging.migrations;
    if (
      base.name !== input.productionWorkerName ||
      production.name !== input.productionWorkerName ||
      staging.name !== input.workerName ||
      !accountMatches(base, input.accountId) ||
      !accountMatches(production, input.accountId) ||
      !accountMatches(staging, input.accountId) ||
      staging.workers_dev !== true ||
      !isObject(variables) ||
      Object.keys(variables).length !== EXPECTED_BINDING_NAMES.length ||
      !EXPECTED_BINDING_NAMES.every(
        (name) => variables[name] === input.expectedNonSecretVariables[name],
      ) ||
      !isObject(secrets) ||
      Object.keys(secrets).length !== 1 ||
      !exactStringArray(secrets.required, REQUIRED_SECRETS) ||
      !isObject(durableObjects) ||
      !Array.isArray(durableObjects.bindings) ||
      durableObjects.bindings.length !== 1 ||
      !isObject(durableObjects.bindings[0]) ||
      Object.keys(durableObjects.bindings[0]).length !== 2 ||
      durableObjects.bindings[0].name !== "COLLABORATION_ROOMS" ||
      durableObjects.bindings[0].class_name !== "CollaborationRoom" ||
      durableObjects.bindings[0].script_name !== undefined ||
      !isObject(browser) ||
      Object.keys(browser).length !== 1 ||
      browser.binding !== "BROWSER" ||
      !Array.isArray(migrations) ||
      migrations.length !== 1 ||
      !isObject(migrations[0]) ||
      Object.keys(migrations[0]).length !== 2 ||
      migrations[0].tag !== "v1" ||
      !exactStringArray(migrations[0].new_sqlite_classes, ["CollaborationRoom"])
    ) {
      throw new Error();
    }
  } catch {
    throw new WorkerBootstrapError("configuration");
  }
};

const isCheckpoint = (value: unknown): value is WorkerBootstrapCheckpoint => {
  if (!isObject(value) || value.schemaVersion !== 1 || typeof value.inputFingerprint !== "string") {
    return false;
  }
  if (value.phase === "pending-worker-deployment") {
    return value.versionId === null && value.deploymentId === null;
  }
  if (value.phase === "version-returned") {
    return isUuid(value.versionId) && value.deploymentId === null;
  }
  return value.phase === "complete" && isUuid(value.versionId) && isUuid(value.deploymentId);
};

const loadCheckpoint = async (
  store: WorkerBootstrapStore,
  inputFingerprint: string,
): Promise<WorkerBootstrapCheckpoint | null> => {
  let checkpoint: WorkerBootstrapCheckpoint | null;
  try {
    checkpoint = await store.load();
  } catch {
    throw new WorkerBootstrapError("state");
  }
  if (
    checkpoint !== null &&
    (!isCheckpoint(checkpoint) || checkpoint.inputFingerprint !== inputFingerprint)
  ) {
    throw new WorkerBootstrapError("state");
  }
  return checkpoint;
};

const saveCheckpoint = async (
  store: WorkerBootstrapStore,
  checkpoint: WorkerBootstrapCheckpoint,
): Promise<void> => {
  try {
    await store.save(checkpoint);
  } catch {
    throw new WorkerBootstrapError("state");
  }
};

const runCommand = async (
  dependencies: WorkerBootstrapDependencies,
  input: WorkerBootstrapInput,
  args: readonly string[],
): Promise<WorkerBootstrapCommandResult> => {
  try {
    return await dependencies.run(WRANGLER_EXECUTABLE, args, {
      CLOUDFLARE_ACCOUNT_ID: input.accountId,
      CI: "1",
      NO_COLOR: "1",
    });
  } catch {
    throw new WorkerBootstrapError("operation");
  }
};

const commonInspectionArgs = (input: WorkerBootstrapInput) =>
  [
    "--name",
    input.workerName,
    "--config",
    input.wranglerConfigPath,
    "--env",
    input.wranglerEnvironment,
  ] as const;

const confirmWorkerAbsent = async (
  input: WorkerBootstrapInput,
  dependencies: WorkerBootstrapDependencies,
): Promise<void> => {
  const result = await runCommand(dependencies, input, [
    "deployments",
    "status",
    ...commonInspectionArgs(input),
    "--json",
  ]);
  if (result.exitCode === 0) throw new WorkerBootstrapError("existing-worker");
  const notFoundMarkers = result.stderr.match(/\[code:\s*10007\]/gu) ?? [];
  if (
    typeof result.exitCode !== "number" ||
    result.exitCode === 0 ||
    notFoundMarkers.length !== 1
  ) {
    throw new WorkerBootstrapError("absence-unverified");
  }
};

const parseVersionId = (stdout: string): string => {
  const matches = [
    ...stdout.matchAll(
      /Current Version ID:\s*([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/giu,
    ),
  ];
  if (matches.length !== 1 || !isUuid(matches[0][1])) {
    throw new WorkerBootstrapError("operation");
  }
  return matches[0][1].toLowerCase();
};

const parseJson = (result: WorkerBootstrapCommandResult): unknown => {
  if (result.exitCode !== 0) throw new WorkerBootstrapError("operation");
  try {
    return JSON.parse(result.stdout) as unknown;
  } catch {
    throw new WorkerBootstrapError("operation");
  }
};

const deploymentMessage = (fingerprint: string) => `staging-bootstrap:${fingerprint}`;

const inspectVersion = async (
  input: WorkerBootstrapInput,
  versionId: string,
  fingerprint: string,
  dependencies: WorkerBootstrapDependencies,
): Promise<void> => {
  const response = parseJson(
    await runCommand(dependencies, input, [
      "versions",
      "view",
      versionId,
      ...commonInspectionArgs(input),
      "--json",
    ]),
  );
  if (
    !isObject(response) ||
    response.id !== versionId ||
    !isObject(response.annotations) ||
    response.annotations["workers/message"] !== deploymentMessage(fingerprint) ||
    !isObject(response.resources) ||
    !Array.isArray(response.resources.bindings)
  ) {
    throw new WorkerBootstrapError("operation");
  }
  const bindings = new Map<string, JsonObject>();
  for (const binding of response.resources.bindings) {
    if (!isObject(binding) || typeof binding.name !== "string" || bindings.has(binding.name)) {
      throw new WorkerBootstrapError("operation");
    }
    bindings.set(binding.name, binding);
  }
  if (
    !EXPECTED_BINDING_NAMES.every((name) => {
      const binding = bindings.get(name);
      return (
        binding?.type === "plain_text" && binding.text === input.expectedNonSecretVariables[name]
      );
    }) ||
    !REQUIRED_SECRETS.every((name) => bindings.get(name)?.type === "secret_text")
  ) {
    throw new WorkerBootstrapError("operation");
  }
};

const inspectDeployment = async (
  input: WorkerBootstrapInput,
  versionId: string,
  dependencies: WorkerBootstrapDependencies,
): Promise<string> => {
  const response = parseJson(
    await runCommand(dependencies, input, [
      "deployments",
      "status",
      ...commonInspectionArgs(input),
      "--json",
    ]),
  );
  if (
    !isObject(response) ||
    !isUuid(response.id) ||
    !Array.isArray(response.versions) ||
    response.versions.length !== 1 ||
    !isObject(response.versions[0]) ||
    response.versions[0].version_id !== versionId ||
    response.versions[0].percentage !== 100
  ) {
    throw new WorkerBootstrapError("operation");
  }
  return response.id.toLowerCase();
};

const completeInspection = async (
  input: WorkerBootstrapInput,
  versionId: string,
  fingerprint: string,
  dependencies: WorkerBootstrapDependencies,
): Promise<CompleteWorkerBootstrapCheckpoint> => {
  await inspectVersion(input, versionId, fingerprint, dependencies);
  await saveCheckpoint(dependencies.store, {
    schemaVersion: 1,
    inputFingerprint: fingerprint,
    phase: "version-returned",
    versionId,
    deploymentId: null,
  });
  const deploymentId = await inspectDeployment(input, versionId, dependencies);
  const checkpoint: CompleteWorkerBootstrapCheckpoint = {
    schemaVersion: 1,
    inputFingerprint: fingerprint,
    phase: "complete",
    versionId,
    deploymentId,
  };
  await saveCheckpoint(dependencies.store, checkpoint);
  return checkpoint;
};

const resultFromCheckpoint = (
  input: WorkerBootstrapInput,
  checkpoint: CompleteWorkerBootstrapCheckpoint,
): WorkerBootstrapResult => ({
  status: "complete",
  accountId: input.accountId,
  workerName: input.workerName,
  versionId: checkpoint.versionId,
  deploymentId: checkpoint.deploymentId,
  inputFingerprint: checkpoint.inputFingerprint,
});

export async function bootstrapStagingWorker(
  input: WorkerBootstrapInput,
  dependencies: WorkerBootstrapDependencies,
): Promise<WorkerBootstrapResult> {
  validateInput(input);
  validateWranglerConfig(input);
  const fingerprint = workerBootstrapFingerprint(input);
  const checkpoint = await loadCheckpoint(dependencies.store, fingerprint);
  if (checkpoint?.phase === "pending-worker-deployment") {
    throw new WorkerBootstrapError("blocked");
  }
  if (checkpoint?.phase === "complete") {
    return resultFromCheckpoint(input, checkpoint);
  }
  if (checkpoint?.phase === "version-returned") {
    const complete = await completeInspection(
      input,
      checkpoint.versionId,
      fingerprint,
      dependencies,
    );
    return resultFromCheckpoint(input, complete);
  }

  await confirmWorkerAbsent(input, dependencies);
  let deploy: WorkerBootstrapCommandResult;
  try {
    deploy = await dependencies.withSecretsFile(async (secretsFile) => {
      await saveCheckpoint(dependencies.store, {
        schemaVersion: 1,
        inputFingerprint: fingerprint,
        phase: "pending-worker-deployment",
        versionId: null,
        deploymentId: null,
      });
      return runCommand(dependencies, input, [
        "deploy",
        "--config",
        input.wranglerConfigPath,
        "--env",
        input.wranglerEnvironment,
        "--secrets-file",
        secretsFile,
        "--message",
        deploymentMessage(fingerprint),
      ]);
    });
  } catch (error) {
    if (error instanceof WorkerBootstrapError) throw error;
    throw new WorkerBootstrapError("operation");
  }
  if (deploy.exitCode !== 0) throw new WorkerBootstrapError("operation");
  const versionId = parseVersionId(deploy.stdout);
  await saveCheckpoint(dependencies.store, {
    schemaVersion: 1,
    inputFingerprint: fingerprint,
    phase: "version-returned",
    versionId,
    deploymentId: null,
  });
  const complete = await completeInspection(input, versionId, fingerprint, dependencies);
  return resultFromCheckpoint(input, complete);
}

export async function recoverPendingStagingWorker(
  input: WorkerBootstrapInput,
  versionId: string,
  dependencies: WorkerBootstrapDependencies,
): Promise<WorkerBootstrapResult> {
  validateInput(input);
  validateWranglerConfig(input);
  if (!isUuid(versionId)) throw new WorkerBootstrapError("invalid-input");
  const normalizedVersionId = versionId.toLowerCase();
  const fingerprint = workerBootstrapFingerprint(input);
  const checkpoint = await loadCheckpoint(dependencies.store, fingerprint);
  if (
    checkpoint?.phase !== "pending-worker-deployment" &&
    !(checkpoint?.phase === "version-returned" && checkpoint.versionId === normalizedVersionId)
  ) {
    throw new WorkerBootstrapError("state");
  }
  const complete = await completeInspection(input, normalizedVersionId, fingerprint, dependencies);
  return resultFromCheckpoint(input, complete);
}
