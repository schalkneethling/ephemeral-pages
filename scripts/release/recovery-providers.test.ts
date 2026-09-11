import { access, mkdtemp, mkdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import type { RecoveryProviderPlan, RecoveryTargetEvidence } from "./recovery-provider-adapters.ts";
import { createRecoveryProviderDependencies } from "./recovery-providers.ts";
import type { RecoveryRecord } from "./recovery-record.ts";
import type { NetlifyVariableScope } from "./providers.ts";
import type { ReleaseConfig } from "./schema.ts";
import type { WorkerArtifactManifest } from "./worker-artifacts.ts";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true })));
});

const appVariables = (origin: string) => ({
  APP_MODE: "production",
  PUBLIC_BASE_URL: origin,
});

const workerVariables = (origin: string, workerName: string) => ({
  ALLOWED_ORIGINS: origin,
  PAGE_CONTENT_ORIGIN: origin,
  PUBLIC_WORKER_ORIGIN: `https://${workerName}.example.workers.dev`,
  TICKET_AUDIENCE: workerName,
});

const appTarget = (siteId: string, origin: string) => ({
  accountId: "netlify-account",
  expectedNonSecretVariables: appVariables(origin),
  requiredSecretNames: ["RATE_LIMIT_SECRET"],
  requiredVariableScopes: {
    APP_MODE: ["builds", "functions", "runtime"] as NetlifyVariableScope[],
    PUBLIC_BASE_URL: ["builds", "functions", "runtime"] as NetlifyVariableScope[],
    RATE_LIMIT_SECRET: ["builds", "functions", "runtime"] as NetlifyVariableScope[],
  },
  siteId,
});

const workerTarget = (workerName: string, origin: string) => ({
  accountId: "cloudflare-account",
  expectedNonSecretVariables: workerVariables(origin, workerName),
  requiredSecretNames: ["TICKET_HMAC_SECRET", "ADMIN_TOKEN"],
  workerName,
  wranglerConfigPath: "collaboration-worker/wrangler.jsonc",
  wranglerEnvironment: workerName === "production-worker" ? "production" : "staging",
});

const configuration = (): ReleaseConfig => ({
  environments: {
    production: {
      cloudflare: workerTarget("production-worker", "https://production.example.test"),
      netlify: appTarget("production-site", "https://production.example.test"),
    },
    staging: {
      cloudflare: workerTarget("staging-worker", "https://staging.example.test"),
      netlify: appTarget("staging-site", "https://staging.example.test"),
    },
  },
  integrationBranch: "main",
  version: 1,
});

const manifest = (): WorkerArtifactManifest => ({
  entrypoint: "bundle/index.js",
  files: [
    { bytes: 1, path: "bundle/index.js", sha256: "1".repeat(64) },
    { bytes: 1, path: "config/wrangler.json", sha256: "2".repeat(64) },
  ],
  policy: {
    browser: { binding: "BROWSER" },
    compatibilityDate: "2026-08-16",
    compatibilityFlags: ["nodejs_compat"],
    durableObjects: {
      bindings: [{ className: "CollaborationRoom", name: "COLLABORATION_ROOMS" }],
    },
    migrations: [{ newSqliteClasses: ["CollaborationRoom"], tag: "v1" }],
    observability: { enabled: true },
    requiredSecretNames: ["TICKET_HMAC_SECRET", "ADMIN_TOKEN"],
    workersDev: true,
  },
  schemaVersion: 1,
  source: { configPath: "collaboration-worker/wrangler.jsonc", configSha256: "3".repeat(64) },
  target: {
    accountId: "cloudflare-account",
    environment: "production",
    productionWorkerName: "production-worker",
    workerName: "production-worker",
    wranglerEnvironment: "production",
  },
  uploadConfig: { bytes: 1, path: "config/wrangler.json", sha256: "2".repeat(64) },
  wranglerVersion: "4.125.0",
});

const createInput = async () => {
  const parent = await mkdtemp(join(tmpdir(), "recovery-provider-factory-"));
  temporaryDirectories.push(parent);
  const repositoryRoot = join(parent, "repository");
  await mkdir(repositoryRoot);
  const releaseConfiguration = configuration();
  const target = releaseConfiguration.environments.production;
  const workerManifest = manifest();
  const plan: RecoveryProviderPlan = {
    environment: "production",
    expectedCurrent: {
      netlifyDeployId: "current-netlify",
      workerDeploymentId: "current-worker-deployment",
      workerVersionId: "current-worker-version",
    },
    netlify: {
      ...target.netlify!,
      origin: "https://production.example.test",
      targetIdentity: { commitRef: "a".repeat(40), kind: "source-commit" as const },
    },
    productionSiteId: "production-site",
    productionWorkerName: "production-worker",
    requested: {
      netlifyDeployId: "target-netlify",
      workerDeploymentId: "target-worker-deployment",
      workerVersionId: "target-worker-version",
    },
    worker: {
      accountId: "cloudflare-account",
      artifactInput: {
        artifactDirectory: join(parent, "worker-artifact"),
        environment: "production" as const,
        productionWorkerName: "production-worker",
        repositoryRoot,
        sourceConfigSha256: "3".repeat(64),
        target: target.cloudflare!,
      },
      preparedArtifacts: {
        artifactDirectory: join(parent, "worker-artifact"),
        manifest: workerManifest,
        manifestSha256: "b".repeat(64),
      },
      targetArtifactSha256: "b".repeat(64),
      targetScriptEtag: "c".repeat(64),
      workerName: "production-worker",
    },
  };
  const evidence: RecoveryTargetEvidence = {
    expectedCurrent: plan.expectedCurrent,
    inspectionSha256: "d".repeat(64),
    netlifyIdentity: "source-commit",
    netlifyVariablesVerified: true,
    requested: plan.requested,
    workerArtifactSha256: "b".repeat(64),
    workerMigrationTag: "v1",
    workerScriptEtag: "c".repeat(64),
    workerSecretBindingNames: ["TICKET_HMAC_SECRET", "ADMIN_TOKEN"],
    workerSecretValuesObservable: false,
  };
  return {
    configuration: releaseConfiguration,
    evidence,
    plan,
    repositoryRoot,
    smokeOutputDirectory: join(parent, "smoke"),
  };
};

const inspections = (netlifyDeployId = "current-netlify") => ({
  cloudflare: {
    accountId: "cloudflare-account",
    deploymentId: "current-worker-deployment",
    nonSecretVariables: Object.fromEntries(
      Object.keys(workerVariables("https://production.example.test", "production-worker")).map(
        (name) => [name, { matchesExpected: true, present: true }],
      ),
    ),
    requiredSecrets: { ADMIN_TOKEN: true, TICKET_HMAC_SECRET: true },
    traffic: [{ percentage: 100, versionId: "current-worker-version" }],
    workerName: "production-worker",
  },
  netlify: {
    nonSecretVariables: {
      APP_MODE: { matchesExpected: true, present: true },
      PUBLIC_BASE_URL: { matchesExpected: true, present: true },
    },
    publishLocked: true,
    publishedDeployId: netlifyDeployId,
    publishedDeploySource: { branch: null, commitRef: null, context: "production" },
    requiredSecrets: { RATE_LIMIT_SECRET: true },
    siteId: "production-site",
    variableScopesMatch: true,
  },
});

const overrides = (evidence: RecoveryTargetEvidence) => {
  const state = inspections();
  const createNetlifyClient = vi.fn(async () => vi.fn(async () => ({})));
  const createWorkerTransport = vi.fn(async () => ({ dispatch: vi.fn(async () => ({})) }));
  const inspectTargets = vi.fn(async () => evidence);
  const verifyTargets = vi.fn(async () => evidence);
  const restoreNetlify = vi.fn(async (_plan, current, dependencies) => {
    await dependencies.checkpoint({
      inspectionSha256: current.inspectionSha256,
      phase: "netlify-restore-pending",
      targetDeployId: "target-netlify",
    });
    await dependencies.checkpoint({
      inspectionSha256: current.inspectionSha256,
      phase: "netlify-restore-response-received",
      restoredDeployId: "target-netlify",
    });
    return {
      deployId: "target-netlify",
      inspectionSha256: current.inspectionSha256,
      status: "restored-and-locked" as const,
    };
  });
  const restoreWorker = vi.fn(async (_plan, current, _netlify, dependencies) => {
    await dependencies.checkpoint({
      inspectionSha256: current.inspectionSha256,
      netlifyDeployId: "target-netlify",
      phase: "worker-rollback-pending",
      targetVersionId: "target-worker-version",
    });
    await dependencies.checkpoint({
      deploymentId: "new-worker-deployment",
      inspectionSha256: current.inspectionSha256,
      phase: "worker-rollback-response-received",
      versionId: "target-worker-version",
    });
    return {
      deploymentId: "new-worker-deployment",
      inspectionSha256: current.inspectionSha256,
      status: "rolled-back" as const,
      versionId: "target-worker-version",
    };
  });
  const reconcileNetlify = vi.fn(async (_plan, current) => ({
    result: {
      deployId: "target-netlify",
      inspectionSha256: current.inspectionSha256,
      status: "restored-and-locked" as const,
    },
    status: "completed" as const,
  }));
  const reconcileWorker = vi.fn(async (_plan, current, _netlify, returnedDeploymentId) => ({
    result: {
      deploymentId: returnedDeploymentId ?? "discovered-worker-deployment",
      inspectionSha256: current.inspectionSha256,
      status: "rolled-back" as const,
      versionId: "target-worker-version",
    },
    status: "completed" as const,
  }));
  return {
    adapters: {
      inspectTargets,
      reconcileNetlify,
      reconcileWorker,
      restoreNetlify,
      restoreWorker,
      verifyTargets,
    },
    createNetlifyClient,
    createWorkerTransport,
    inspectCloudflare: vi.fn(async () => state.cloudflare),
    inspectNetlify: vi.fn(async () => state.netlify),
    runSmoke: vi.fn(async (arguments_) => ({
      checks: [{ id: "pair.valid", outcome: "passed" as const, summary: "Pair passed." }],
      configuration: { fingerprint: "e".repeat(64), source: "default" as const },
      environment: arguments_.environment,
      operation: "collaboration-smoke" as const,
      outcome: "passed" as const,
      schemaVersion: 1 as const,
      usage: { captureRequested: true, captureRequests: 1 as const, uploads: 1 as const },
    })),
    state,
    uniqueId: vi.fn(() => "unique-report"),
  };
};

const previousRecord = (evidence: RecoveryTargetEvidence): RecoveryRecord => ({
  environment: "production",
  journal: [],
  operation: "production-recovery",
  outcome: "blocked",
  recoveryPlanSha256: "f".repeat(64),
  recoveryRunIds: [1],
  results: {},
  schemaVersion: 1,
  sourceProductionRecordSha256: "1".repeat(64),
  sourceProductionRunId: 1,
  stages: {
    inspect: "passed",
    "restore-netlify": "blocked",
    "restore-worker": "pending",
    "verify-pair": "pending",
    "verify-transition": "pending",
  },
  startingPair: evidence.expectedCurrent,
  targetEvidence: evidence,
  targetPair: evidence.requested,
});

describe("recovery provider factory", () => {
  it("keeps credentials and provider inspection lazy until a runner dependency is invoked", async () => {
    const input = await createInput();
    const controlled = overrides(input.evidence);
    const dependencies = await createRecoveryProviderDependencies(input, controlled);

    expect(controlled.createNetlifyClient).not.toHaveBeenCalled();
    expect(controlled.createWorkerTransport).not.toHaveBeenCalled();
    await expect(access(input.smokeOutputDirectory)).rejects.toThrow();

    await expect(dependencies.verifyTargets()).resolves.toEqual(input.evidence);
    expect(controlled.createNetlifyClient).toHaveBeenCalledOnce();
    expect(controlled.createWorkerTransport).toHaveBeenCalledOnce();
    expect(controlled.adapters.inspectTargets).toHaveBeenCalledOnce();
  });

  it("translates fixed adapter checkpoints into the existing provider journal grammar", async () => {
    const input = await createInput();
    const controlled = overrides(input.evidence);
    const dependencies = await createRecoveryProviderDependencies(input, controlled);
    await dependencies.verifyTargets();
    const checkpoints: unknown[] = [];

    await dependencies.restoreNetlify(async (value) => {
      checkpoints.push(value);
    });
    await dependencies.restoreWorker(async (value) => {
      checkpoints.push(value);
    });

    expect(checkpoints).toEqual([
      {
        deployId: "target-netlify",
        operation: "restoreSiteDeploy",
        phase: "pending-mutation",
        siteId: "production-site",
      },
      {
        deployId: "target-netlify",
        operation: "restoreSiteDeploy",
        phase: "mutation-response-received",
        publishedDeployId: "target-netlify",
        siteId: "production-site",
      },
      {
        accountId: "cloudflare-account",
        artifactManifestSha256: "b".repeat(64),
        baselineDeploymentId: "current-worker-deployment",
        migrationPolicy: { artifactTag: "v1", change: "none", expectedCurrentTag: "v1" },
        phase: "pending-activation",
        versionId: "target-worker-version",
        workerName: "production-worker",
      },
      {
        accountId: "cloudflare-account",
        artifactManifestSha256: "b".repeat(64),
        baselineDeploymentId: "current-worker-deployment",
        deploymentId: "new-worker-deployment",
        migrationPolicy: { artifactTag: "v1", change: "none", expectedCurrentTag: "v1" },
        phase: "activation-response-received",
        versionId: "target-worker-version",
        workerName: "production-worker",
      },
    ]);
  });

  it("uses saved target evidence to reverify a partial resume without changing its marker", async () => {
    const input = await createInput();
    const controlled = overrides(input.evidence);
    const previous = previousRecord(input.evidence);
    const dependencies = await createRecoveryProviderDependencies(
      { ...input, previous },
      controlled,
    );

    await expect(dependencies.verifyTargets()).resolves.toEqual(input.evidence);
    expect(controlled.adapters.inspectTargets).not.toHaveBeenCalled();
    expect(controlled.adapters.verifyTargets).toHaveBeenCalledWith(
      input.plan,
      input.evidence,
      input.evidence.expectedCurrent,
      expect.any(Object),
    );
  });

  it("reconciles saved Netlify and returned Worker IDs without invoking mutations", async () => {
    const input = await createInput();
    const controlled = overrides(input.evidence);
    const previous = previousRecord(input.evidence);
    previous.results.netlify = { publishedDeployId: "target-netlify" };
    previous.stages["restore-netlify"] = "passed";
    previous.stages["restore-worker"] = "blocked";
    previous.journal.push({
      step: "restore-worker",
      value: {
        accountId: "cloudflare-account",
        artifactManifestSha256: "b".repeat(64),
        baselineDeploymentId: "current-worker-deployment",
        deploymentId: "returned-worker-deployment",
        migrationPolicy: { artifactTag: "v1", change: "none", expectedCurrentTag: "v1" },
        phase: "activation-response-received",
        versionId: "target-worker-version",
        workerName: "production-worker",
      },
    });
    const dependencies = await createRecoveryProviderDependencies(
      { ...input, previous },
      controlled,
    );

    await expect(dependencies.reconcile("restore-worker", previous)).resolves.toEqual({
      worker: {
        deploymentId: "returned-worker-deployment",
        versionId: "target-worker-version",
      },
    });
    expect(controlled.adapters.reconcileWorker).toHaveBeenCalledWith(
      input.plan,
      input.evidence,
      expect.objectContaining({ deployId: "target-netlify" }),
      "returned-worker-deployment",
      expect.any(Object),
    );
    expect(controlled.adapters.restoreNetlify).not.toHaveBeenCalled();
    expect(controlled.adapters.restoreWorker).not.toHaveBeenCalled();
  });

  it("writes a fixed sanitized smoke report to a new external directory", async () => {
    const input = await createInput();
    const controlled = overrides(input.evidence);
    const dependencies = await createRecoveryProviderDependencies(input, controlled);

    await expect(dependencies.verifyTransition()).resolves.toBe(true);
    const saved = JSON.parse(
      await readFile(join(input.smokeOutputDirectory, "transition-unique-report.json"), "utf8"),
    ) as unknown;
    expect(saved).toMatchObject({ environment: "production", outcome: "passed" });
    expect(controlled.runSmoke).toHaveBeenCalledWith(
      expect.objectContaining({ capture: true, environment: "production" }),
      input.configuration,
    );
  });

  it("rejects a production target relabeled as staging before creating provider clients", async () => {
    const input = await createInput();
    const controlled = overrides(input.evidence);
    input.plan.environment = "staging";

    await expect(createRecoveryProviderDependencies(input, controlled)).rejects.toThrow(
      "Recovery provider input is invalid.",
    );
    expect(controlled.createNetlifyClient).not.toHaveBeenCalled();
  });
});
