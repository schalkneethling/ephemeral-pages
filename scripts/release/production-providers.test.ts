import { readdir, readFile, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, expect, it, vi } from "vitest";

import { artifactHash } from "./artifact-contract.ts";
import { NetlifyArtifactError } from "./netlify-artifacts.ts";
import type { HeldNetlifyDeployment } from "./netlify-deployment.ts";
import { preparedReleaseSchema } from "./prepare.ts";
import {
  createProductionProviderDependencies,
  type ProductionProviderFactoryInput,
  type ProductionProviderFactoryOverrides,
} from "./production-providers.ts";
import { productionRecordSchema, productionSteps } from "./production-record.ts";
import { ProviderInspectionError } from "./providers.ts";
import { releaseConfigSchema } from "./schema.ts";
import type { ActivatedProductionWorkerVersion } from "./worker-release.ts";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { force: true, recursive: true })));
});

const configuredVariables = (expected: Readonly<Record<string, string>>) =>
  Object.fromEntries(
    Object.keys(expected).map((name) => [name, { matchesExpected: true, present: true }]),
  );

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "production-providers-"));
  roots.push(root);
  const repositoryRoot = join(root, "repository");
  const artifactDirectory = join(root, "artifacts");
  const smokeOutputDirectory = join(root, "smoke");
  await mkdir(join(repositoryRoot, "collaboration-worker"), { recursive: true });
  await mkdir(join(artifactDirectory, "netlify"), { recursive: true });
  await mkdir(join(artifactDirectory, "worker"), { recursive: true });
  await writeFile(join(repositoryRoot, "wrangler.jsonc"), "{}\n");
  await writeFile(
    join(artifactDirectory, "netlify/inventory.json"),
    JSON.stringify({ functionSchedules: [], functions: [], functionsConfig: {} }),
  );
  await writeFile(join(artifactDirectory, "worker/worker-artifact.json"), "{}\n");
  const appTarget = {
    accountId: "netlify-account",
    expectedNonSecretVariables: {
      COLLABORATION_WEBSOCKET_URL: "wss://worker.example.test",
      PUBLIC_BASE_URL: "https://app.example.test",
    },
    requiredSecretNames: [],
    requiredVariableScopes: {
      COLLABORATION_WEBSOCKET_URL: ["runtime" as const],
      PUBLIC_BASE_URL: ["runtime" as const],
    },
    siteId: "production-site",
  };
  const workerTarget = {
    accountId: "cloudflare-account",
    expectedNonSecretVariables: { PUBLIC_WORKER_ORIGIN: "https://worker.example.test" },
    requiredSecretNames: [],
    workerName: "production-worker",
    wranglerConfigPath: "wrangler.jsonc",
    wranglerEnvironment: "production",
  };
  const configuration = {
    environments: {
      production: { cloudflare: workerTarget, netlify: appTarget },
      staging: { cloudflare: null, netlify: null },
    },
    integrationBranch: "main",
    version: 1 as const,
  };
  const prepared = {
    artifacts: {
      netlify: { directory: "netlify" as const, sha256: "a".repeat(64) },
      worker: { directory: "worker" as const, sha256: "b".repeat(64) },
    },
    operation: "prepare" as const,
    outcome: "passed" as const,
    schemaVersion: 1 as const,
    source: {
      candidate: "c".repeat(40),
      configurationFingerprint: "d".repeat(64),
      environment: "production" as const,
      tree: "e".repeat(40),
    },
    toolchain: { bun: "1.3.14" as const },
  };
  const approval = {
    affected: { cloudflare: true, netlify: true },
    baseline: {
      environment: "production" as const,
      providers: {
        cloudflare: {
          accountId: workerTarget.accountId,
          deploymentId: "baseline-worker-deployment",
          sourceCommit: "f".repeat(40),
          traffic: [{ percentage: 100, versionId: "baseline-worker-version" }],
          workerName: workerTarget.workerName,
        },
        netlify: {
          publishLocked: true,
          publishedDeployId: "baseline-netlify-deploy",
          siteId: appTarget.siteId,
          sourceCommit: "f".repeat(40),
        },
      },
      version: 1 as const,
    },
    candidate: "f".repeat(40),
    compatibility: "compatible" as const,
    configurationFingerprint: artifactHash(
      JSON.stringify(releaseConfigSchema.parse(configuration)),
    ),
    migration: {
      artifactTag: "v1" as const,
      change: "none" as const,
      expectedCurrentTag: "v1" as const,
    },
    operation: "release-approval" as const,
    recoveryOrder: ["netlify", "cloudflare"] as ["netlify", "cloudflare"],
    schemaVersion: 1 as const,
    stagingPreparationSha256: "1".repeat(64),
    stagingRehearsalSha256: "2".repeat(64),
    tree: prepared.source.tree,
  };
  const authorization = { assertArtifact: vi.fn(() => undefined) };
  const input: ProductionProviderFactoryInput = {
    approval,
    artifactDirectory,
    authorization,
    configuration,
    prepared,
    repositoryRoot,
    smokeOutputDirectory,
  };
  const appInspection = {
    nonSecretVariables: configuredVariables(appTarget.expectedNonSecretVariables),
    publishLocked: true,
    publishedDeployId: "baseline-netlify-deploy",
    publishedDeploySource: { branch: "main", commitRef: "f".repeat(40), context: "production" },
    requiredSecrets: {},
    siteId: appTarget.siteId,
    variableScopesMatch: true,
  };
  const workerInspection = {
    accountId: workerTarget.accountId,
    deploymentId: "baseline-worker-deployment",
    nonSecretVariables: configuredVariables(workerTarget.expectedNonSecretVariables),
    requiredSecrets: {},
    traffic: [{ percentage: 100, versionId: "baseline-worker-version" }],
    workerName: workerTarget.workerName,
  };
  const held: HeldNetlifyDeployment = {
    acknowledgedUploads: 1,
    artifactSha256: prepared.artifacts.netlify.sha256,
    baselineDeployId: "baseline-netlify-deploy",
    candidate: prepared.source.candidate,
    candidateDeployId: "candidate-netlify-deploy",
    context: "production",
    siteId: appTarget.siteId,
    state: "ready",
  };
  const upload = {
    accountId: workerTarget.accountId,
    artifactManifestSha256: prepared.artifacts.worker.sha256,
    baselineDeploymentId: "baseline-worker-deployment",
    migrationPolicy: approval.migration,
    scriptEtag: "3".repeat(64),
    status: "uploaded" as const,
    versionId: "candidate-worker-version",
    workerName: workerTarget.workerName,
  };
  const activated: ActivatedProductionWorkerVersion = {
    accountId: workerTarget.accountId,
    artifactManifestSha256: prepared.artifacts.worker.sha256,
    deploymentId: "candidate-worker-deployment",
    migrationPolicy: approval.migration,
    scriptEtag: upload.scriptEtag,
    status: "activated",
    versionId: upload.versionId,
    workerName: workerTarget.workerName,
  };
  return {
    activated,
    appInspection,
    authorization,
    held,
    input,
    upload,
    workerInspection,
  };
}

const createOverrides = (
  value: Awaited<ReturnType<typeof fixture>>,
): ProductionProviderFactoryOverrides => ({
  createNetlifyClient: async () => async () => ({}),
  createWorkerTransport: () => ({ dispatch: async () => ({}) }),
  inspectCloudflare: vi.fn(async () => value.workerInspection),
  inspectNetlify: vi.fn(async () => value.appInspection),
  providerRun: async () => {
    throw new Error("Injected inspection does not run a CLI.");
  },
  verifyNetlifyArtifacts: vi.fn(async () => undefined),
  verifySource: vi.fn(async () => ({
    configuration: releaseConfigSchema.parse(value.input.configuration),
    source: preparedReleaseSchema.parse(value.input.prepared).source,
  })),
  verifyWorkerArtifacts: vi.fn(async () => ({}) as never),
});

it("binds exact production inputs to all four provider operations", async () => {
  const value = await fixture();
  const overrides = createOverrides(value);
  const calls: string[] = [];
  overrides.adapters = {
    activateWorker: vi.fn(async (input) => {
      calls.push("activate");
      expect(input.artifactInput.target.workerName).toBe("production-worker");
      return value.activated;
    }),
    holdNetlify: vi.fn(async (input) => {
      calls.push("hold");
      expect(input).toMatchObject({
        baselineDeployId: "baseline-netlify-deploy",
        environment: "production",
        siteId: "production-site",
      });
      return value.held;
    }),
    publishNetlify: vi.fn(async () => {
      calls.push("publish");
      return { publishedDeployId: value.held.candidateDeployId };
    }),
    uploadWorker: vi.fn(async (input) => {
      calls.push("upload");
      expect(input).toMatchObject({
        artifactInput: { environment: "production" },
        expectedBaselineDeploymentId: "baseline-worker-deployment",
      });
      return value.upload;
    }),
  };
  const dependencies = await createProductionProviderDependencies(value.input, overrides);
  const checkpoint = async () => undefined;
  expect(await dependencies.inspect()).toEqual({
    netlifyDeployId: "baseline-netlify-deploy",
    workerDeploymentId: "baseline-worker-deployment",
    workerVersionId: "baseline-worker-version",
  });
  await dependencies.holdNetlify(checkpoint);
  await dependencies.uploadWorker(checkpoint);
  await dependencies.activateWorker(value.upload, checkpoint);
  await dependencies.publishNetlify(value.held, checkpoint);
  expect(calls).toEqual(["hold", "upload", "activate", "publish"]);
  expect(value.authorization.assertArtifact).toHaveBeenCalledTimes(2);
});

it("blocks an unlocked production publication before creating mutation clients", async () => {
  const value = await fixture();
  const overrides = createOverrides(value);
  overrides.inspectNetlify = vi.fn(async () => ({ ...value.appInspection, publishLocked: false }));
  const createNetlifyClient = vi.fn(async () => async () => ({}));
  overrides.createNetlifyClient = createNetlifyClient;
  await expect(createProductionProviderDependencies(value.input, overrides)).rejects.toMatchObject({
    diagnostic: {
      assertion: "provider-policy",
      classification: "assertion",
      operation: "getSite",
      provider: "netlify",
    },
  });
  expect(createNetlifyClient).not.toHaveBeenCalled();
});

it("preserves a native inspection cause without exposing it in the diagnostic", async () => {
  const value = await fixture();
  const overrides = createOverrides(value);
  const cause = new Error("secret-bearing-native-cause");
  const failure = new ProviderInspectionError(
    {
      provider: "netlify",
      operation: "getSite",
      classification: "assertion",
      assertion: "site-identity",
    },
    cause,
  );
  overrides.inspectNetlify = vi.fn(async () => {
    throw failure;
  });

  let observed: unknown;
  try {
    await createProductionProviderDependencies(value.input, overrides);
  } catch (error) {
    observed = error;
  }
  expect(observed).toBe(failure);
  expect((observed as Error).cause).toBe(cause);
  expect(JSON.stringify((observed as ProviderInspectionError).diagnostic)).not.toContain(
    "secret-bearing-native-cause",
  );
});

it("retains a safe nonzero inspection exit code", async () => {
  const value = await fixture();
  const overrides = createOverrides(value);
  delete overrides.providerRun;
  delete overrides.inspectNetlify;
  overrides.inspectCloudflare = vi.fn(async () => value.workerInspection);
  overrides.run = vi.fn(async () => ({ exitCode: 23, stdout: "secret-bearing-command-output" }));

  let observed: unknown;
  try {
    await createProductionProviderDependencies(value.input, overrides);
  } catch (error) {
    observed = error;
  }
  expect(observed).toBeInstanceOf(ProviderInspectionError);
  expect((observed as ProviderInspectionError).diagnostic).toEqual({
    provider: "netlify",
    operation: "getSite",
    classification: "command",
    commandKind: "failed",
    exitCode: 23,
  });
  expect(JSON.stringify((observed as ProviderInspectionError).diagnostic)).not.toContain(
    "secret-bearing-command-output",
  );
});

it("classifies a known artifact failure while preserving its native cause in memory", async () => {
  const value = await fixture();
  const overrides = createOverrides(value);
  const underlying = new NetlifyArtifactError("state");
  Object.defineProperty(underlying, "cause", {
    value: new Error("secret-bearing-artifact-cause"),
  });
  overrides.verifyNetlifyArtifacts = vi.fn(async () => {
    throw underlying;
  });

  let observed: unknown;
  try {
    await createProductionProviderDependencies(value.input, overrides);
  } catch (error) {
    observed = error;
  }
  expect(observed).toBeInstanceOf(ProviderInspectionError);
  expect((observed as Error).cause).toBe(underlying);
  expect((observed as ProviderInspectionError).diagnostic).toEqual({
    provider: "netlify",
    operation: "verifyArtifacts",
    classification: "assertion",
    assertion: "artifact-state",
  });
  expect(JSON.stringify(observed)).not.toContain("secret-bearing-artifact-cause");
});

it("selects only the exact activation response checkpoint before a later inspection", async () => {
  const value = await fixture();
  const overrides = createOverrides(value);
  const order: string[] = [];
  overrides.inspectNetlify = vi.fn(async () => {
    order.push("inspect-netlify");
    return value.appInspection;
  });
  overrides.inspectCloudflare = vi.fn(async () => {
    order.push("inspect-cloudflare");
    return value.workerInspection;
  });
  overrides.adapters = {
    reconcileWorker: vi.fn(async (_input, reconciliation) => {
      order.push("reconcile-worker");
      expect(reconciliation).toEqual({
        deploymentId: "candidate-worker-deployment",
        phase: "activation-response-received",
        upload: value.upload,
      });
      return value.activated;
    }),
  };
  const dependencies = await createProductionProviderDependencies(value.input, overrides);
  order.length = 0;
  const timestamp = new Date(0).toISOString();
  const record = productionRecordSchema.parse({
    approvalSha256: "4".repeat(64),
    candidate: value.input.approval.candidate,
    configurationFingerprint: value.input.approval.configurationFingerprint,
    createdAt: timestamp,
    journal: [
      {
        at: timestamp,
        step: "upload-worker",
        value: {
          accountId: value.upload.accountId,
          artifactManifestSha256: "9".repeat(64),
          deploymentId: "wrong-step-deployment",
          phase: "activation-response-received",
          versionId: value.upload.versionId,
          workerName: value.upload.workerName,
        },
      },
      {
        at: timestamp,
        step: "activate-worker",
        value: {
          accountId: value.upload.accountId,
          artifactManifestSha256: value.upload.artifactManifestSha256,
          deploymentId: "candidate-worker-deployment",
          phase: "activation-response-received",
          versionId: value.upload.versionId,
          workerName: value.upload.workerName,
        },
      },
      {
        at: timestamp,
        step: "activate-worker",
        value: {
          accountId: value.upload.accountId,
          artifactManifestSha256: "9".repeat(64),
          deploymentId: "different-artifact-deployment",
          phase: "activation-response-received",
          versionId: value.upload.versionId,
          workerName: value.upload.workerName,
        },
      },
    ],
    operation: "production-release",
    originalRunId: 1,
    outcome: "blocked",
    preparationSha256: "5".repeat(64),
    priorPair: {
      netlifyDeployId: "baseline-netlify-deploy",
      workerDeploymentId: "baseline-worker-deployment",
      workerVersionId: "baseline-worker-version",
    },
    promotionCommit: value.input.prepared.source.candidate,
    recovery: "inspect-recorded-targets-before-recovery",
    results: { uploadedWorker: value.upload },
    runIds: [1],
    schemaVersion: 1,
    stages: Object.fromEntries(productionSteps.map((step) => [step, "pending"])),
    tree: value.input.prepared.source.tree,
    updatedAt: timestamp,
  });
  await expect(dependencies.reconcile("activate-worker", record)).resolves.toEqual({
    activatedWorker: {
      deploymentId: value.activated.deploymentId,
      versionId: value.activated.versionId,
    },
  });
  expect(order).toEqual(["reconcile-worker"]);
  await dependencies.inspect();
  expect(order.slice(1).sort()).toEqual(["inspect-cloudflare", "inspect-netlify"]);
});

it("revalidates retained results and writes unique sanitized production smoke reports", async () => {
  const value = await fixture();
  const overrides = createOverrides(value);
  const retainedNetlify = vi.fn(async () => undefined);
  const retainedWorker = vi.fn(async () => undefined);
  overrides.adapters = {
    verifyRetainedNetlify: retainedNetlify,
    verifyRetainedWorker: retainedWorker,
  };
  const ids = ["first-report", "second-report"];
  overrides.uniqueId = () => ids.shift() ?? "unexpected";
  overrides.runSmoke = vi.fn(
    async (arguments_) =>
      ({
        checks: [{ id: "pair.live", outcome: "passed", summary: "The live pair passed." }],
        configuration: { fingerprint: "6".repeat(64), source: "default" },
        environment: arguments_.environment,
        operation: "collaboration-smoke",
        outcome: "passed",
        rawProviderValue: "must-not-be-written",
        schemaVersion: 1,
        usage: { captureRequested: true, captureRequests: 1, uploads: 1 },
      }) as never,
  );
  const dependencies = await createProductionProviderDependencies(value.input, overrides);
  const timestamp = new Date(0).toISOString();
  const record = productionRecordSchema.parse({
    approvalSha256: "4".repeat(64),
    candidate: value.input.approval.candidate,
    configurationFingerprint: value.input.approval.configurationFingerprint,
    createdAt: timestamp,
    journal: [],
    operation: "production-release",
    originalRunId: 1,
    outcome: "blocked",
    preparationSha256: "5".repeat(64),
    priorPair: {
      netlifyDeployId: "baseline-netlify-deploy",
      workerDeploymentId: "baseline-worker-deployment",
      workerVersionId: "baseline-worker-version",
    },
    promotionCommit: value.input.prepared.source.candidate,
    recovery: "inspect-recorded-targets-before-recovery",
    results: {
      activatedWorker: {
        deploymentId: value.activated.deploymentId,
        versionId: value.activated.versionId,
      },
      heldNetlify: value.held,
      publishedNetlify: { publishedDeployId: value.held.candidateDeployId },
      uploadedWorker: value.upload,
    },
    runIds: [1],
    schemaVersion: 1,
    stages: Object.fromEntries(productionSteps.map((step) => [step, "passed"])),
    tree: value.input.prepared.source.tree,
    updatedAt: timestamp,
  });
  await dependencies.verifyRetained(record);
  expect(retainedNetlify).toHaveBeenCalledWith(
    expect.anything(),
    value.held,
    value.held.candidateDeployId,
    expect.anything(),
  );
  expect(retainedWorker).toHaveBeenCalledWith(
    expect.anything(),
    value.upload,
    record.results.activatedWorker,
    expect.anything(),
  );
  await expect(dependencies.verifyTransition()).resolves.toBe(true);
  await expect(dependencies.verifyPair()).resolves.toBe(true);
  const files = (await readdir(value.input.smokeOutputDirectory)).sort();
  expect(files).toEqual(["pair-second-report.json", "transition-first-report.json"]);
  const reports = await Promise.all(
    files.map((file) => readFile(join(value.input.smokeOutputDirectory, file), "utf8")),
  );
  expect(reports.join("\n")).not.toContain("must-not-be-written");
});
