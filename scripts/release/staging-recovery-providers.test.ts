import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";

import type { RecoveryProviderPlan } from "./recovery-provider-adapters.ts";
import { createStagingRecoveryProviderDependencies } from "./recovery-providers.ts";
import { recoverySteps } from "./recovery-record.ts";
import { stagingRecoveryRecordSchema } from "./staging-recovery-runner.ts";
import type { ReleaseConfig } from "./schema.ts";
import type { WorkerArtifactManifest } from "./worker-artifacts.ts";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "staging-recovery-provider-"));
  roots.push(root);
  const repositoryRoot = join(root, "repository");
  await mkdir(repositoryRoot);
  const workerTarget = {
    accountId: "cloudflare-account",
    expectedNonSecretVariables: { PUBLIC_WORKER_ORIGIN: "https://staging-worker.example.com" },
    requiredSecretNames: ["WORKER_SECRET"],
    workerName: "staging-worker",
    wranglerConfigPath: "collaboration-worker/wrangler.jsonc",
    wranglerEnvironment: "staging",
  };
  const netlifyTarget = {
    accountId: "netlify-account",
    expectedNonSecretVariables: { PUBLIC_BASE_URL: "https://staging.example.com" },
    requiredSecretNames: ["STAGE_SECRET"],
    requiredVariableScopes: {
      PUBLIC_BASE_URL: ["builds" as const],
      STAGE_SECRET: ["functions" as const],
    },
    siteId: "staging-site",
  };
  const configuration: ReleaseConfig = {
    version: 1,
    integrationBranch: "stage",
    environments: {
      staging: { cloudflare: workerTarget, netlify: netlifyTarget },
      production: {
        cloudflare: {
          ...workerTarget,
          workerName: "production-worker",
          wranglerEnvironment: "production",
        },
        netlify: {
          ...netlifyTarget,
          siteId: "production-site",
          expectedNonSecretVariables: { PUBLIC_BASE_URL: "https://example.com" },
        },
      },
    },
  };
  const manifest: WorkerArtifactManifest = {
    schemaVersion: 1,
    wranglerVersion: "4.125.0",
    target: {
      accountId: "cloudflare-account",
      environment: "staging",
      productionWorkerName: "production-worker",
      workerName: "staging-worker",
      wranglerEnvironment: "staging",
    },
    source: { configPath: "collaboration-worker/wrangler.jsonc", configSha256: "a".repeat(64) },
    uploadConfig: { bytes: 1, path: "config/wrangler.json", sha256: "b".repeat(64) },
    entrypoint: "bundle/index.js",
    files: [
      { bytes: 1, path: "bundle/index.js", sha256: "c".repeat(64) },
      { bytes: 1, path: "config/wrangler.json", sha256: "b".repeat(64) },
    ],
    policy: {
      browser: { binding: "BROWSER" },
      compatibilityDate: "2026-08-23",
      compatibilityFlags: ["nodejs_compat"],
      durableObjects: {
        bindings: [{ className: "CollaborationRoom", name: "COLLABORATION_ROOMS" }],
      },
      migrations: [{ newSqliteClasses: ["CollaborationRoom"], tag: "v1" }],
      observability: { enabled: true },
      requiredSecretNames: ["TICKET_HMAC_SECRET", "ADMIN_TOKEN"],
      workersDev: true,
    },
  };
  const expectedCurrent = {
    netlifyDeployId: "current-netlify",
    workerDeploymentId: "current-worker-deployment",
    workerVersionId: "current-worker-version",
  };
  const requested = {
    netlifyDeployId: "target-netlify",
    workerDeploymentId: "target-worker-deployment",
    workerVersionId: "target-worker-version",
  };
  const artifactDirectory = join(root, "worker-artifact");
  const plan: RecoveryProviderPlan & { environment: "staging" } = {
    environment: "staging",
    expectedCurrent,
    requested,
    productionSiteId: "production-site",
    productionWorkerName: "production-worker",
    netlify: {
      ...netlifyTarget,
      origin: "https://staging.example.com",
      targetIdentity: {
        kind: "release-artifact",
        candidate: "d".repeat(40),
        artifactSha256: "e".repeat(64),
      },
    },
    worker: {
      accountId: "cloudflare-account",
      workerName: "staging-worker",
      targetArtifactSha256: "f".repeat(64),
      targetScriptEtag: "1".repeat(64),
      artifactInput: {
        artifactDirectory,
        environment: "staging",
        productionWorkerName: "production-worker",
        repositoryRoot,
        sourceConfigSha256: "a".repeat(64),
        target: workerTarget,
      },
      preparedArtifacts: {
        artifactDirectory,
        manifest,
        manifestSha256: "f".repeat(64),
      },
    },
  };
  const previous = stagingRecoveryRecordSchema.parse({
    schemaVersion: 1,
    operation: "staging-recovery",
    environment: "staging",
    sourceRehearsalRunId: 20,
    sourceRehearsalSha256: "2".repeat(64),
    targetRehearsalRunId: 10,
    targetRehearsalSha256: "3".repeat(64),
    sourceSha256: "4".repeat(64),
    configurationFingerprint: "5".repeat(64),
    recoveryPlanSha256: "6".repeat(64),
    recoveryRunIds: [30],
    startingPair: expectedCurrent,
    targetPair: requested,
    targetEvidence: {
      inspectionSha256: "7".repeat(64),
      requested,
      expectedCurrent,
      netlifyIdentity: "release-artifact",
      netlifyVariablesVerified: true,
      workerArtifactSha256: "f".repeat(64),
      workerMigrationTag: "v1",
      workerScriptEtag: "1".repeat(64),
      workerSecretBindingNames: ["TICKET_HMAC_SECRET", "ADMIN_TOKEN"],
      workerSecretValuesObservable: false,
    },
    outcome: "blocked",
    stages: Object.fromEntries(recoverySteps.map((step) => [step, "pending"])),
    results: {},
    journal: [],
  });
  return { configuration, plan, previous, repositoryRoot, root };
}

it("accepts a staging record for lazy resume without constructing provider clients", async () => {
  const fixture_ = await fixture();
  const createNetlifyClient = vi.fn();
  const createWorkerTransport = vi.fn();
  const dependencies = await createStagingRecoveryProviderDependencies(
    {
      configuration: fixture_.configuration,
      plan: fixture_.plan,
      previous: fixture_.previous,
      repositoryRoot: fixture_.repositoryRoot,
      smokeOutputDirectory: join(fixture_.root, "smoke"),
    },
    { createNetlifyClient, createWorkerTransport },
  );
  expect(dependencies).toEqual(
    expect.objectContaining({
      inspect: expect.any(Function),
      reconcile: expect.any(Function),
      restoreNetlify: expect.any(Function),
      restoreWorker: expect.any(Function),
      verifyTargets: expect.any(Function),
    }),
  );
  expect(createNetlifyClient).not.toHaveBeenCalled();
  expect(createWorkerTransport).not.toHaveBeenCalled();
});

it("rejects a production plan through the staging factory", async () => {
  const fixture_ = await fixture();
  const productionWorker = fixture_.configuration.environments.production.cloudflare!;
  const productionNetlify = fixture_.configuration.environments.production.netlify!;
  const productionPlan: RecoveryProviderPlan = {
    ...fixture_.plan,
    environment: "production",
    netlify: {
      ...productionNetlify,
      origin: productionNetlify.expectedNonSecretVariables.PUBLIC_BASE_URL,
      targetIdentity: { commitRef: "d".repeat(40), kind: "source-commit" },
    },
    worker: {
      ...fixture_.plan.worker,
      workerName: productionWorker.workerName,
      artifactInput: {
        ...fixture_.plan.worker.artifactInput,
        environment: "production",
        target: productionWorker,
      },
      preparedArtifacts: {
        ...fixture_.plan.worker.preparedArtifacts,
        manifest: {
          ...fixture_.plan.worker.preparedArtifacts.manifest,
          target: {
            ...fixture_.plan.worker.preparedArtifacts.manifest.target,
            environment: "production",
            workerName: productionWorker.workerName,
            wranglerEnvironment: "production",
          },
        },
      },
    },
  };
  await expect(
    createStagingRecoveryProviderDependencies({
      configuration: fixture_.configuration,
      plan: productionPlan as never,
      repositoryRoot: fixture_.repositoryRoot,
      smokeOutputDirectory: join(fixture_.root, "smoke"),
    }),
  ).rejects.toThrow();
});
