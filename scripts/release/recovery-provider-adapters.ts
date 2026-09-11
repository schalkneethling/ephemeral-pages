import { createHash } from "node:crypto";

import { createAuthenticatedNetlifyDeploymentClient } from "./netlify-deployment.ts";
import type { NetlifyVariableScope } from "./providers.ts";
import {
  verifyWorkerArtifacts,
  type PrepareWorkerArtifactsInput,
  type PreparedWorkerArtifacts,
  type WorkerArtifactManifest,
} from "./worker-artifacts.ts";
import type { WorkerReleaseTransport } from "./worker-release.ts";

type JsonObject = Record<string, unknown>;

export type RecoveryPair = {
  netlifyDeployId: string;
  workerDeploymentId: string;
  workerVersionId: string;
};

export type NetlifyRecoveryIdentity =
  | { kind: "source-commit"; commitRef: string }
  | { kind: "release-artifact"; artifactSha256: string; candidate: string };

export type RecoveryProviderPlan = {
  environment: "production" | "staging";
  requested: RecoveryPair;
  expectedCurrent: RecoveryPair;
  productionSiteId: string;
  productionWorkerName: string;
  netlify: {
    accountId: string;
    expectedNonSecretVariables: Readonly<Record<string, string>>;
    origin: string;
    requiredSecretNames: readonly string[];
    requiredVariableScopes: Readonly<Record<string, readonly NetlifyVariableScope[]>>;
    siteId: string;
    targetIdentity: NetlifyRecoveryIdentity;
  };
  worker: {
    accountId: string;
    artifactInput: PrepareWorkerArtifactsInput;
    preparedArtifacts: PreparedWorkerArtifacts;
    targetArtifactSha256: string;
    targetScriptEtag: string;
    workerName: string;
  };
};

export type RecoveryTargetEvidence = {
  inspectionVersion?: 2;
  inspectionSha256: string;
  requested: RecoveryPair;
  expectedCurrent: RecoveryPair;
  netlifyIdentity: "release-artifact" | "source-commit";
  netlifyVariablesVerified: true;
  workerArtifactSha256: string;
  workerMigrationTag: "v1";
  workerScriptEtag: string;
  workerSecretBindingNames: string[];
  workerSecretValuesObservable: false;
};

export type NetlifyRecoveryResult = {
  deployId: string;
  inspectionSha256: string;
  status: "restored-and-locked";
};

export type WorkerRecoveryResult = {
  deploymentId: string;
  inspectionSha256: string;
  status: "rolled-back";
  versionId: string;
};

export type RecoveryProviderCheckpoint =
  | {
      inspectionSha256: string;
      phase: "netlify-restore-pending";
      targetDeployId: string;
    }
  | {
      inspectionSha256: string;
      phase: "netlify-restore-response-received";
      restoredDeployId: string;
    }
  | {
      inspectionSha256: string;
      netlifyDeployId: string;
      phase: "worker-rollback-pending";
      targetVersionId: string;
    }
  | {
      deploymentId: string;
      inspectionSha256: string;
      phase: "worker-rollback-response-received";
      versionId: string;
    };

export type RecoveryNetlifyOperation =
  | "getEnvVars"
  | "getSite"
  | "getSiteDeploy"
  | "restoreSiteDeploy";

export type RecoveryNetlifyClient = (
  operation: RecoveryNetlifyOperation,
  parameters: Record<string, unknown>,
  signal: AbortSignal,
) => Promise<unknown>;

export const createAuthenticatedRecoveryNetlifyClient = async (
  repositoryRoot: string,
): Promise<RecoveryNetlifyClient> => {
  const client = await createAuthenticatedNetlifyDeploymentClient(repositoryRoot);
  return client as unknown as RecoveryNetlifyClient;
};

export type RecoveryProviderDependencies = {
  checkpoint(value: RecoveryProviderCheckpoint): Promise<void>;
  netlifyClient: RecoveryNetlifyClient;
  timeoutMs?: number;
  verifyArtifacts?: typeof verifyWorkerArtifacts;
  workerTransport: WorkerReleaseTransport;
};

export type RecoveryReconciliation<T> =
  | { status: "completed"; result: T }
  | { status: "not-completed" };

export class RecoveryProviderError extends Error {
  readonly kind: "ambiguous" | "checkpoint" | "invalid-input" | "preflight" | "verification";

  constructor(kind: RecoveryProviderError["kind"]) {
    const messages = {
      ambiguous: "The recovery mutation outcome is ambiguous; do not retry it blindly.",
      checkpoint: "The recovery checkpoint could not be persisted.",
      "invalid-input": "The recovery provider plan is invalid.",
      preflight: "The recovery provider preflight did not pass.",
      verification: "The recovery provider readback did not verify.",
    } as const;
    super(messages[kind]);
    this.kind = kind;
    this.name = "RecoveryProviderError";
  }
}

const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,255}$/u;
const SHA256 = /^[0-9a-f]{64}$/u;
const FULL_SHA = /^[0-9a-f]{40}$/u;
const SCRIPT_ETAG = /^[0-9a-f]{32,128}$/u;
const VARIABLE_NAME = /^[A-Z][A-Z0-9_]*$/u;
const SCOPES = new Set<NetlifyVariableScope>(["builds", "functions", "runtime", "post-processing"]);
const MAX_TIMEOUT_MS = 60_000;
const DEFAULT_TIMEOUT_MS = 15_000;

const isObject = (value: unknown): value is JsonObject =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const normalizeEtag = (value: unknown): string | undefined => {
  if (typeof value !== "string") return undefined;
  const unquoted = value.startsWith('"') && value.endsWith('"') ? value.slice(1, -1) : value;
  return SCRIPT_ETAG.test(unquoted) ? unquoted.toLowerCase() : undefined;
};

const stable = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(stable);
  if (!isObject(value)) return value;
  return Object.fromEntries(
    Object.entries(value)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => [key, stable(item)]),
  );
};

const planDigest = (plan: RecoveryProviderPlan): string =>
  createHash("sha256")
    .update(
      JSON.stringify(
        stable({
          environment: plan.environment,
          expectedCurrent: plan.expectedCurrent,
          inspectionVersion: 2,
          netlify: plan.netlify,
          requested: plan.requested,
          productionSiteId: plan.productionSiteId,
          productionWorkerName: plan.productionWorkerName,
          worker: {
            accountId: plan.worker.accountId,
            artifactInput: {
              environment: plan.worker.artifactInput.environment,
              productionWorkerName: plan.worker.artifactInput.productionWorkerName,
              sourceConfigSha256: plan.worker.artifactInput.sourceConfigSha256,
              target: plan.worker.artifactInput.target,
            },
            manifestSha256: plan.worker.preparedArtifacts.manifestSha256,
            targetArtifactSha256: plan.worker.targetArtifactSha256,
            targetScriptEtag: plan.worker.targetScriptEtag,
            workerName: plan.worker.workerName,
          },
        }),
      ),
    )
    .digest("hex");

const timeout = (dependencies: RecoveryProviderDependencies): number => {
  const value = dependencies.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  if (!Number.isSafeInteger(value) || value < 1 || value > MAX_TIMEOUT_MS)
    throw new RecoveryProviderError("invalid-input");
  return value;
};

const workerPath = (plan: RecoveryProviderPlan, suffix: string): string =>
  `/accounts/${encodeURIComponent(plan.worker.accountId)}/workers/scripts/${encodeURIComponent(plan.worker.workerName)}${suffix}`;

const servicePath = (plan: RecoveryProviderPlan): string =>
  `/accounts/${encodeURIComponent(plan.worker.accountId)}/workers/services/${encodeURIComponent(plan.worker.workerName)}`;

const validatePlan = (plan: RecoveryProviderPlan): void => {
  const { netlify, requested, expectedCurrent, worker } = plan;
  const origin = (() => {
    try {
      return new URL(netlify.origin);
    } catch {
      return undefined;
    }
  })();
  const variableNames = [
    ...Object.keys(netlify.expectedNonSecretVariables),
    ...netlify.requiredSecretNames,
  ];
  const scopes = Object.keys(netlify.requiredVariableScopes);
  if (
    ![
      netlify.siteId,
      netlify.accountId,
      plan.productionSiteId,
      plan.productionWorkerName,
      worker.accountId,
      worker.workerName,
    ].every((id) => SAFE_ID.test(id)) ||
    !Object.values(requested).every((id) => SAFE_ID.test(id)) ||
    !Object.values(expectedCurrent).every((id) => SAFE_ID.test(id)) ||
    origin?.protocol !== "https:" ||
    origin.origin !== netlify.origin ||
    worker.artifactInput.environment !== plan.environment ||
    worker.artifactInput.target.wranglerEnvironment !== plan.environment ||
    worker.artifactInput.target.accountId !== worker.accountId ||
    worker.artifactInput.target.workerName !== worker.workerName ||
    worker.artifactInput.productionWorkerName !== plan.productionWorkerName ||
    (plan.environment === "production"
      ? netlify.siteId !== plan.productionSiteId || worker.workerName !== plan.productionWorkerName
      : netlify.siteId === plan.productionSiteId ||
        worker.workerName === plan.productionWorkerName) ||
    worker.preparedArtifacts.manifestSha256 !== worker.targetArtifactSha256 ||
    !SHA256.test(worker.targetArtifactSha256) ||
    normalizeEtag(worker.targetScriptEtag) !== worker.targetScriptEtag ||
    variableNames.length === 0 ||
    new Set(variableNames).size !== variableNames.length ||
    variableNames.some((name) => !VARIABLE_NAME.test(name)) ||
    scopes.length !== variableNames.length ||
    scopes.some((name) => !variableNames.includes(name)) ||
    Object.values(netlify.requiredVariableScopes).some(
      (values) =>
        values.length === 0 ||
        new Set(values).size !== values.length ||
        values.some((value) => !SCOPES.has(value)),
    ) ||
    (netlify.targetIdentity.kind === "source-commit"
      ? !FULL_SHA.test(netlify.targetIdentity.commitRef)
      : !FULL_SHA.test(netlify.targetIdentity.candidate) ||
        !SHA256.test(netlify.targetIdentity.artifactSha256))
  ) {
    throw new RecoveryProviderError("invalid-input");
  }
};

const netlifyRead = async (
  dependencies: RecoveryProviderDependencies,
  operation: Exclude<RecoveryNetlifyOperation, "restoreSiteDeploy">,
  parameters: Record<string, unknown>,
): Promise<unknown> => {
  try {
    return await dependencies.netlifyClient(
      operation,
      parameters,
      AbortSignal.timeout(timeout(dependencies)),
    );
  } catch {
    throw new RecoveryProviderError("preflight");
  }
};

const netlifyMutation = async (
  dependencies: RecoveryProviderDependencies,
  parameters: Record<string, unknown>,
): Promise<unknown> => {
  try {
    return await dependencies.netlifyClient(
      "restoreSiteDeploy",
      parameters,
      AbortSignal.timeout(timeout(dependencies)),
    );
  } catch {
    throw new RecoveryProviderError("ambiguous");
  }
};

const workerDispatch = async (
  dependencies: RecoveryProviderDependencies,
  request: { body?: string; method: "GET" | "POST"; path: string },
  mutation: boolean,
): Promise<unknown> => {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      dependencies.workerTransport.dispatch({ ...request, signal: controller.signal }),
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => {
          controller.abort();
          reject(new Error());
        }, timeout(dependencies));
      }),
    ]);
  } catch {
    throw new RecoveryProviderError(mutation ? "ambiguous" : "preflight");
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
};

const checkpoint = async (
  dependencies: RecoveryProviderDependencies,
  value: RecoveryProviderCheckpoint,
  responseReceived = false,
): Promise<void> => {
  try {
    await dependencies.checkpoint(value);
  } catch {
    throw new RecoveryProviderError(responseReceived ? "ambiguous" : "checkpoint");
  }
};

const containsConfigured = (actual: unknown, expected: unknown): boolean => {
  if (Array.isArray(expected))
    return (
      Array.isArray(actual) &&
      actual.length === expected.length &&
      expected.every((item, index) => containsConfigured(actual[index], item))
    );
  if (isObject(expected))
    return (
      isObject(actual) &&
      Object.entries(expected).every(([key, item]) => containsConfigured(actual[key], item))
    );
  return Object.is(actual, expected);
};

const parseDeployment = (value: unknown): { id: string; versionId: string; marker?: string } => {
  if (
    !isObject(value) ||
    typeof value.id !== "string" ||
    !SAFE_ID.test(value.id) ||
    !Array.isArray(value.versions) ||
    value.versions.length !== 1
  )
    throw new Error();
  const traffic = value.versions[0];
  if (
    !isObject(traffic) ||
    typeof traffic.version_id !== "string" ||
    !SAFE_ID.test(traffic.version_id) ||
    traffic.percentage !== 100
  )
    throw new Error();
  const marker =
    isObject(value.annotations) && typeof value.annotations["workers/message"] === "string"
      ? value.annotations["workers/message"]
      : undefined;
  return { id: value.id, versionId: traffic.version_id, marker };
};

const parseDeployments = (
  value: unknown,
): readonly { id: string; versionId: string; marker?: string }[] => {
  if (!isObject(value) || !Array.isArray(value.deployments) || value.deployments.length === 0)
    throw new Error();
  const deployments = value.deployments.map(parseDeployment);
  if (new Set(deployments.map(({ id }) => id)).size !== deployments.length) throw new Error();
  return deployments;
};

const assertNetlifyEnvironment = (value: unknown, plan: RecoveryProviderPlan): void => {
  if (!Array.isArray(value)) throw new Error();
  const variables = new Map<string, JsonObject>();
  for (const item of value) {
    if (
      !isObject(item) ||
      !VARIABLE_NAME.test(String(item.key)) ||
      variables.has(String(item.key)) ||
      !Array.isArray(item.scopes) ||
      !Array.isArray(item.values)
    )
      throw new Error();
    variables.set(String(item.key), item);
  }
  for (const [name, expected] of Object.entries(plan.netlify.expectedNonSecretVariables)) {
    const item = variables.get(name);
    if (!item || item.is_secret !== false || !Array.isArray(item.values)) throw new Error();
    const production = item.values.filter(
      (entry): entry is JsonObject => isObject(entry) && entry.context === "production",
    );
    const all = item.values.filter(
      (entry): entry is JsonObject => isObject(entry) && entry.context === "all",
    );
    const selected = production.length > 0 ? production : all;
    if (selected.length !== 1 || selected[0].value !== expected) throw new Error();
  }
  for (const name of plan.netlify.requiredSecretNames) {
    const item = variables.get(name);
    if (
      !item ||
      item.is_secret !== true ||
      !Array.isArray(item.values) ||
      !item.values.some(
        (entry) => isObject(entry) && (entry.context === "production" || entry.context === "all"),
      )
    )
      throw new Error();
  }
  for (const [name, expectedScopes] of Object.entries(plan.netlify.requiredVariableScopes)) {
    const actual = variables.get(name)?.scopes;
    if (
      !Array.isArray(actual) ||
      expectedScopes.some(
        (scope) => !actual.includes(scope === "post-processing" ? "post_processing" : scope),
      )
    )
      throw new Error();
  }
};

const assertSite = (value: unknown, plan: RecoveryProviderPlan, expectedDeployId: string): void => {
  if (!isObject(value) || !isObject(value.published_deploy)) throw new Error();
  const settings = value.build_settings ?? {};
  if (!isObject(settings)) throw new Error();
  if (
    value.id !== plan.netlify.siteId ||
    value.account_id !== plan.netlify.accountId ||
    value.ssl_url !== plan.netlify.origin ||
    settings.repo_url ||
    settings.repo_path ||
    value.published_deploy.id !== expectedDeployId ||
    value.published_deploy.state !== "ready" ||
    value.published_deploy.locked !== true
  )
    throw new Error();
};

const assertTargetDeploy = (value: unknown, plan: RecoveryProviderPlan): void => {
  if (
    !isObject(value) ||
    value.id !== plan.requested.netlifyDeployId ||
    value.site_id !== plan.netlify.siteId ||
    value.state !== "ready" ||
    value.context !== "production" ||
    (value.draft !== undefined && value.draft !== false)
  )
    throw new Error();
  const identity = plan.netlify.targetIdentity;
  if (
    (identity.kind === "source-commit" && value.commit_ref !== identity.commitRef) ||
    (identity.kind === "release-artifact" &&
      value.title !== `release-${identity.candidate}-${identity.artifactSha256}`)
  )
    throw new Error();
};

const expectedBinding = (
  binding: JsonObject,
  manifest: WorkerArtifactManifest,
  plan: RecoveryProviderPlan,
): boolean => {
  if (typeof binding.name !== "string" || typeof binding.type !== "string") return false;
  if (manifest.policy.requiredSecretNames.includes(binding.name as never))
    return binding.type === "secret_text";
  if (binding.name === manifest.policy.durableObjects.bindings[0].name)
    return (
      binding.type === "durable_object_namespace" &&
      binding.class_name === manifest.policy.durableObjects.bindings[0].className &&
      binding.script_name === undefined &&
      binding.environment === undefined
    );
  if (binding.name === manifest.policy.browser.binding) return binding.type === "browser";
  return (
    Object.hasOwn(plan.worker.artifactInput.target.expectedNonSecretVariables, binding.name) &&
    binding.type === "plain_text" &&
    binding.text === plan.worker.artifactInput.target.expectedNonSecretVariables[binding.name]
  );
};

const assertTargetVersion = (
  value: unknown,
  plan: RecoveryProviderPlan,
  manifest: WorkerArtifactManifest,
): void => {
  if (
    !isObject(value) ||
    !isObject(value.resources) ||
    !isObject(value.resources.script) ||
    !isObject(value.resources.script_runtime) ||
    !Array.isArray(value.resources.bindings)
  )
    throw new Error();
  const expectedNames = [
    ...manifest.policy.requiredSecretNames,
    ...Object.keys(plan.worker.artifactInput.target.expectedNonSecretVariables),
    manifest.policy.durableObjects.bindings[0].name,
    manifest.policy.browser.binding,
  ];
  const actualNames = value.resources.bindings.map((binding) =>
    isObject(binding) ? binding.name : undefined,
  );
  if (
    value.id !== plan.requested.workerVersionId ||
    normalizeEtag(value.resources.script.etag) !== plan.worker.targetScriptEtag ||
    value.resources.script_runtime.compatibility_date !== manifest.policy.compatibilityDate ||
    JSON.stringify(value.resources.script_runtime.compatibility_flags) !==
      JSON.stringify(manifest.policy.compatibilityFlags) ||
    value.resources.bindings.length !== expectedNames.length ||
    new Set(actualNames).size !== actualNames.length ||
    !expectedNames.every((name) => actualNames.includes(name)) ||
    value.resources.bindings.some(
      (binding) => !isObject(binding) || !expectedBinding(binding, manifest, plan),
    ) ||
    !isObject(value.annotations) ||
    value.annotations["workers/tag"] !== plan.worker.targetArtifactSha256
  )
    throw new Error();
};

const inspectNetlify = async (
  plan: RecoveryProviderPlan,
  dependencies: RecoveryProviderDependencies,
  expectedPublishedDeployId: string,
): Promise<void> => {
  assertSite(
    await netlifyRead(dependencies, "getSite", { siteId: plan.netlify.siteId }),
    plan,
    expectedPublishedDeployId,
  );
  assertTargetDeploy(
    await netlifyRead(dependencies, "getSiteDeploy", {
      deployId: plan.requested.netlifyDeployId,
      siteId: plan.netlify.siteId,
    }),
    plan,
  );
  assertNetlifyEnvironment(
    await netlifyRead(dependencies, "getEnvVars", {
      accountId: plan.netlify.accountId,
      siteId: plan.netlify.siteId,
    }),
    plan,
  );
};

const inspectWorker = async (
  plan: RecoveryProviderPlan,
  dependencies: RecoveryProviderDependencies,
  expectedLatest: { deploymentId: string; versionId: string } = {
    deploymentId: plan.expectedCurrent.workerDeploymentId,
    versionId: plan.expectedCurrent.workerVersionId,
  },
): Promise<{
  deployments: readonly { id: string; versionId: string; marker?: string }[];
  manifest: WorkerArtifactManifest;
}> => {
  const manifest = await (dependencies.verifyArtifacts ?? verifyWorkerArtifacts)(
    plan.worker.artifactInput,
    plan.worker.preparedArtifacts,
  );
  if (
    manifest.target.environment !== plan.environment ||
    manifest.target.accountId !== plan.worker.accountId ||
    manifest.target.workerName !== plan.worker.workerName ||
    manifest.policy.migrations.length !== 1 ||
    manifest.policy.migrations[0].tag !== "v1"
  )
    throw new Error();
  const service = await workerDispatch(
    dependencies,
    { method: "GET", path: servicePath(plan) },
    false,
  );
  if (
    !isObject(service) ||
    !isObject(service.default_environment) ||
    !isObject(service.default_environment.script) ||
    service.default_environment.script.migration_tag !== "v1" ||
    !containsConfigured(
      service.default_environment.script.observability,
      manifest.policy.observability,
    )
  )
    throw new Error();
  const deployments = parseDeployments(
    await workerDispatch(
      dependencies,
      { method: "GET", path: workerPath(plan, "/deployments") },
      false,
    ),
  );
  if (
    deployments[0].id !== expectedLatest.deploymentId ||
    deployments[0].versionId !== expectedLatest.versionId ||
    !deployments.some(
      ({ id, versionId }) =>
        id === plan.requested.workerDeploymentId && versionId === plan.requested.workerVersionId,
    )
  )
    throw new Error();
  assertTargetVersion(
    await workerDispatch(
      dependencies,
      {
        method: "GET",
        path: workerPath(plan, `/versions/${encodeURIComponent(plan.requested.workerVersionId)}`),
      },
      false,
    ),
    plan,
    manifest,
  );
  const secrets = await workerDispatch(
    dependencies,
    { method: "GET", path: workerPath(plan, "/secrets") },
    false,
  );
  if (
    !Array.isArray(secrets) ||
    !manifest.policy.requiredSecretNames.every((name) =>
      secrets.some(
        (secret) => isObject(secret) && secret.name === name && secret.type === "secret_text",
      ),
    )
  )
    throw new Error();
  return { deployments, manifest };
};

const assertEvidenceBindings = (
  plan: RecoveryProviderPlan,
  evidence: RecoveryTargetEvidence,
): void => {
  if (
    evidence.netlifyIdentity !== plan.netlify.targetIdentity.kind ||
    evidence.netlifyVariablesVerified !== true ||
    evidence.workerArtifactSha256 !== plan.worker.targetArtifactSha256 ||
    evidence.workerMigrationTag !== "v1" ||
    evidence.workerScriptEtag !== plan.worker.targetScriptEtag ||
    JSON.stringify(evidence.workerSecretBindingNames) !==
      JSON.stringify(plan.worker.preparedArtifacts.manifest.policy.requiredSecretNames) ||
    evidence.workerSecretValuesObservable !== false ||
    JSON.stringify(evidence.requested) !== JSON.stringify(plan.requested) ||
    JSON.stringify(evidence.expectedCurrent) !== JSON.stringify(plan.expectedCurrent)
  )
    throw new RecoveryProviderError("invalid-input");
};

const assertEvidence = (plan: RecoveryProviderPlan, evidence: RecoveryTargetEvidence): void => {
  assertEvidenceBindings(plan, evidence);
  if (evidence.inspectionVersion !== 2 || evidence.inspectionSha256 !== planDigest(plan))
    throw new RecoveryProviderError("invalid-input");
};

const targetEvidence = (
  plan: RecoveryProviderPlan,
  manifest: WorkerArtifactManifest,
): RecoveryTargetEvidence => ({
  expectedCurrent: { ...plan.expectedCurrent },
  inspectionSha256: planDigest(plan),
  inspectionVersion: 2,
  netlifyIdentity: plan.netlify.targetIdentity.kind,
  netlifyVariablesVerified: true,
  requested: { ...plan.requested },
  workerArtifactSha256: plan.worker.targetArtifactSha256,
  workerMigrationTag: "v1",
  workerScriptEtag: plan.worker.targetScriptEtag,
  workerSecretBindingNames: [...manifest.policy.requiredSecretNames],
  workerSecretValuesObservable: false,
});

export const inspectRecoveryTargets = async (
  plan: RecoveryProviderPlan,
  dependencies: RecoveryProviderDependencies,
): Promise<RecoveryTargetEvidence> => {
  validatePlan(plan);
  try {
    await inspectNetlify(plan, dependencies, plan.expectedCurrent.netlifyDeployId);
    const { manifest } = await inspectWorker(plan, dependencies);
    return targetEvidence(plan, manifest);
  } catch (error) {
    if (error instanceof RecoveryProviderError && error.kind === "invalid-input") throw error;
    throw new RecoveryProviderError("preflight");
  }
};

export const verifyRecoveryTargets = async (
  plan: RecoveryProviderPlan,
  evidence: RecoveryTargetEvidence,
  current: RecoveryPair,
  dependencies: RecoveryProviderDependencies,
): Promise<RecoveryTargetEvidence> => {
  validatePlan(plan);
  assertEvidenceBindings(plan, evidence);
  const legacyStagingEvidence =
    evidence.inspectionVersion === undefined && plan.environment === "staging";
  if (evidence.inspectionVersion === undefined && !legacyStagingEvidence)
    throw new RecoveryProviderError("invalid-input");
  if (!legacyStagingEvidence && evidence.inspectionSha256 !== planDigest(plan))
    throw new RecoveryProviderError("invalid-input");
  if (evidence.inspectionVersion !== undefined && evidence.inspectionVersion !== 2)
    throw new RecoveryProviderError("invalid-input");
  if (!Object.values(current).every((id) => SAFE_ID.test(id)))
    throw new RecoveryProviderError("invalid-input");
  try {
    await inspectNetlify(plan, dependencies, current.netlifyDeployId);
    const { manifest } = await inspectWorker(plan, dependencies, {
      deploymentId: current.workerDeploymentId,
      versionId: current.workerVersionId,
    });
    const verified = targetEvidence(plan, manifest);
    assertEvidenceBindings(plan, verified);
    return legacyStagingEvidence ? verified : evidence;
  } catch {
    throw new RecoveryProviderError("verification");
  }
};

export const restoreRecoveryNetlify = async (
  plan: RecoveryProviderPlan,
  evidence: RecoveryTargetEvidence,
  dependencies: RecoveryProviderDependencies,
): Promise<NetlifyRecoveryResult> => {
  validatePlan(plan);
  assertEvidence(plan, evidence);
  const fresh = await inspectRecoveryTargets(plan, dependencies);
  if (fresh.inspectionSha256 !== evidence.inspectionSha256)
    throw new RecoveryProviderError("preflight");
  await checkpoint(dependencies, {
    inspectionSha256: evidence.inspectionSha256,
    phase: "netlify-restore-pending",
    targetDeployId: plan.requested.netlifyDeployId,
  });
  const response = await netlifyMutation(dependencies, {
    deployId: plan.requested.netlifyDeployId,
    siteId: plan.netlify.siteId,
  });
  if (!isObject(response) || response.id !== plan.requested.netlifyDeployId)
    throw new RecoveryProviderError("ambiguous");
  await checkpoint(
    dependencies,
    {
      inspectionSha256: evidence.inspectionSha256,
      phase: "netlify-restore-response-received",
      restoredDeployId: plan.requested.netlifyDeployId,
    },
    true,
  );
  try {
    await inspectNetlify(plan, dependencies, plan.requested.netlifyDeployId);
  } catch {
    throw new RecoveryProviderError("ambiguous");
  }
  return {
    deployId: plan.requested.netlifyDeployId,
    inspectionSha256: evidence.inspectionSha256,
    status: "restored-and-locked",
  };
};

const assertNetlifyResult = (
  plan: RecoveryProviderPlan,
  evidence: RecoveryTargetEvidence,
  result: NetlifyRecoveryResult,
): void => {
  if (
    result.status !== "restored-and-locked" ||
    result.deployId !== plan.requested.netlifyDeployId ||
    result.inspectionSha256 !== evidence.inspectionSha256
  )
    throw new RecoveryProviderError("invalid-input");
};

const recoveryMarker = (inspectionSha256: string): string => `Recovery ${inspectionSha256}`;

export const rollbackRecoveryWorker = async (
  plan: RecoveryProviderPlan,
  evidence: RecoveryTargetEvidence,
  netlify: NetlifyRecoveryResult,
  dependencies: RecoveryProviderDependencies,
): Promise<WorkerRecoveryResult> => {
  validatePlan(plan);
  assertEvidence(plan, evidence);
  assertNetlifyResult(plan, evidence, netlify);
  try {
    await inspectNetlify(plan, dependencies, plan.requested.netlifyDeployId);
    await inspectWorker(plan, dependencies);
  } catch {
    throw new RecoveryProviderError("preflight");
  }
  await checkpoint(dependencies, {
    inspectionSha256: evidence.inspectionSha256,
    netlifyDeployId: netlify.deployId,
    phase: "worker-rollback-pending",
    targetVersionId: plan.requested.workerVersionId,
  });
  const response = await workerDispatch(
    dependencies,
    {
      body: JSON.stringify({
        annotations: { "workers/message": recoveryMarker(evidence.inspectionSha256) },
        strategy: "percentage",
        versions: [{ percentage: 100, version_id: plan.requested.workerVersionId }],
      }),
      method: "POST",
      path: workerPath(plan, "/deployments"),
    },
    true,
  );
  if (!isObject(response) || typeof response.id !== "string" || !SAFE_ID.test(response.id))
    throw new RecoveryProviderError("ambiguous");
  const deploymentId = response.id;
  await checkpoint(
    dependencies,
    {
      deploymentId,
      inspectionSha256: evidence.inspectionSha256,
      phase: "worker-rollback-response-received",
      versionId: plan.requested.workerVersionId,
    },
    true,
  );
  try {
    const { deployments } = await inspectWorker(plan, dependencies, {
      deploymentId,
      versionId: plan.requested.workerVersionId,
    });
    if (
      deployments[0].id !== deploymentId ||
      deployments[0].versionId !== plan.requested.workerVersionId ||
      deployments[0].marker !== recoveryMarker(evidence.inspectionSha256)
    )
      throw new Error();
  } catch {
    throw new RecoveryProviderError("ambiguous");
  }
  return {
    deploymentId,
    inspectionSha256: evidence.inspectionSha256,
    status: "rolled-back",
    versionId: plan.requested.workerVersionId,
  };
};

export const reconcileRecoveryNetlify = async (
  plan: RecoveryProviderPlan,
  evidence: RecoveryTargetEvidence,
  dependencies: RecoveryProviderDependencies,
): Promise<RecoveryReconciliation<NetlifyRecoveryResult>> => {
  validatePlan(plan);
  assertEvidence(plan, evidence);
  try {
    await inspectNetlify(plan, dependencies, plan.requested.netlifyDeployId);
    return {
      result: {
        deployId: plan.requested.netlifyDeployId,
        inspectionSha256: evidence.inspectionSha256,
        status: "restored-and-locked",
      },
      status: "completed",
    };
  } catch {
    try {
      await inspectNetlify(plan, dependencies, plan.expectedCurrent.netlifyDeployId);
      return { status: "not-completed" };
    } catch {
      throw new RecoveryProviderError("verification");
    }
  }
};

export const reconcileRecoveryWorker = async (
  plan: RecoveryProviderPlan,
  evidence: RecoveryTargetEvidence,
  netlify: NetlifyRecoveryResult,
  returnedDeploymentId: string | undefined,
  dependencies: RecoveryProviderDependencies,
): Promise<RecoveryReconciliation<WorkerRecoveryResult>> => {
  validatePlan(plan);
  assertEvidence(plan, evidence);
  assertNetlifyResult(plan, evidence, netlify);
  if (returnedDeploymentId !== undefined && !SAFE_ID.test(returnedDeploymentId))
    throw new RecoveryProviderError("invalid-input");
  try {
    await inspectNetlify(plan, dependencies, plan.requested.netlifyDeployId);
    const preliminary = parseDeployments(
      await workerDispatch(
        dependencies,
        { method: "GET", path: workerPath(plan, "/deployments") },
        false,
      ),
    );
    const expectedLatest = {
      deploymentId: preliminary[0].id,
      versionId: preliminary[0].versionId,
    };
    const { deployments } = await inspectWorker(plan, dependencies, expectedLatest);
    const latest = deployments[0];
    if (
      latest.versionId === plan.requested.workerVersionId &&
      latest.marker === recoveryMarker(evidence.inspectionSha256) &&
      (returnedDeploymentId === undefined || latest.id === returnedDeploymentId)
    ) {
      return {
        result: {
          deploymentId: latest.id,
          inspectionSha256: evidence.inspectionSha256,
          status: "rolled-back",
          versionId: latest.versionId,
        },
        status: "completed",
      };
    }
    if (
      latest.id === plan.expectedCurrent.workerDeploymentId &&
      latest.versionId === plan.expectedCurrent.workerVersionId
    )
      return { status: "not-completed" };
    throw new Error();
  } catch (error) {
    if (error instanceof RecoveryProviderError && error.kind === "invalid-input") throw error;
    throw new RecoveryProviderError("verification");
  }
};
