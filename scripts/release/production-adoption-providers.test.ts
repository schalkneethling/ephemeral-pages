import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, expect, it, vi } from "vitest";

import { artifactHash } from "./artifact-contract.ts";
import {
  createProductionAdoptionProviderDependencies,
  type ProductionAdoptionProviderFactoryOverrides,
} from "./production-adoption-providers.ts";
import { preparedReleaseSchema } from "./prepare.ts";
import { productionAdoptionRecordSchema } from "./production-adoption-record.ts";
import { productionResultsSchema } from "./production-record.ts";
import { releaseConfigSchema } from "./schema.ts";
import type { WorkerArtifactManifest } from "./worker-artifacts.ts";

const temporaryDirectories: string[] = [];
afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((path) => rm(path, { force: true, recursive: true })),
  );
});

const configuredVariables = (expected: Readonly<Record<string, string>>) =>
  Object.fromEntries(
    Object.keys(expected).map((name) => [name, { matchesExpected: true, present: true }]),
  );

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "adoption-providers-"));
  temporaryDirectories.push(root);
  const repositoryRoot = join(root, "repository");
  const artifactDirectory = join(root, "artifacts");
  const smokeOutputDirectory = join(root, "smoke");
  await mkdir(join(repositoryRoot, "collaboration-worker"), { recursive: true });
  await mkdir(join(artifactDirectory, "worker"), { recursive: true });
  await writeFile(join(repositoryRoot, "collaboration-worker/wrangler.jsonc"), "{}\n");
  await writeFile(join(artifactDirectory, "worker/worker-artifact.json"), "{}\n");
  const appTarget = {
    accountId: "netlify-account",
    expectedNonSecretVariables: {
      COLLABORATION_WEBSOCKET_URL: "wss://worker.example.test",
      PUBLIC_BASE_URL: "https://app.example.test",
    },
    requiredSecretNames: ["APP_SECRET"],
    requiredVariableScopes: {
      APP_SECRET: ["functions" as const],
      COLLABORATION_WEBSOCKET_URL: ["builds" as const],
      PUBLIC_BASE_URL: ["builds" as const],
    },
    siteId: "production-site",
  };
  const workerTarget = {
    accountId: "cloudflare-account",
    expectedNonSecretVariables: {
      ALLOWED_ORIGINS: "https://app.example.test",
      PAGE_CONTENT_ORIGIN: "https://app.example.test",
      PUBLIC_WORKER_ORIGIN: "https://worker.example.test",
      TICKET_AUDIENCE: "production-worker",
    },
    requiredSecretNames: ["TICKET_HMAC_SECRET", "ADMIN_TOKEN"],
    workerName: "production-worker",
    wranglerConfigPath: "collaboration-worker/wrangler.jsonc",
    wranglerEnvironment: "production",
  };
  const configuration = {
    version: 1 as const,
    integrationBranch: "stage",
    environments: {
      staging: {
        netlify: { ...appTarget, siteId: "staging-site" },
        cloudflare: {
          ...workerTarget,
          workerName: "staging-worker",
          wranglerEnvironment: "staging",
        },
      },
      production: { netlify: appTarget, cloudflare: workerTarget },
    },
  };
  const prepared = {
    schemaVersion: 1 as const,
    operation: "prepare" as const,
    outcome: "passed" as const,
    source: {
      candidate: "c".repeat(40),
      tree: "b".repeat(40),
      environment: "production" as const,
      configurationFingerprint: "a".repeat(64),
    },
    toolchain: { bun: "1.3.14" as const },
    artifacts: {
      netlify: { directory: "netlify" as const, sha256: "d".repeat(64) },
      worker: { directory: "worker" as const, sha256: "e".repeat(64) },
    },
  };
  const manifest = {
    schemaVersion: 1,
    wranglerVersion: "4.125.0",
    target: {
      accountId: workerTarget.accountId,
      environment: "production",
      productionWorkerName: workerTarget.workerName,
      workerName: workerTarget.workerName,
      wranglerEnvironment: "production",
    },
    source: {
      configPath: workerTarget.wranglerConfigPath,
      configSha256: "f".repeat(64),
    },
    uploadConfig: { bytes: 3, path: "config/wrangler.json", sha256: "1".repeat(64) },
    entrypoint: "bundle/index.js",
    files: [
      { bytes: 3, path: "bundle/index.js", sha256: "2".repeat(64) },
      { bytes: 3, path: "config/wrangler.json", sha256: "1".repeat(64) },
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
  } as WorkerArtifactManifest;
  const state = {
    netlify: {
      siteId: appTarget.siteId,
      publishedDeployId: "netlify-deploy",
      publishLocked: true,
      publishedDeploySource: {
        branch: "main",
        commitRef: "9".repeat(40),
        context: "production",
      },
      variableScopesMatch: true,
      nonSecretVariables: configuredVariables(appTarget.expectedNonSecretVariables),
      requiredSecrets: { APP_SECRET: true },
    },
    cloudflare: {
      accountId: workerTarget.accountId,
      workerName: workerTarget.workerName,
      deploymentId: "baseline-worker-deployment",
      traffic: [{ versionId: "baseline-worker-version", percentage: 100 }],
      nonSecretVariables: configuredVariables(workerTarget.expectedNonSecretVariables),
      requiredSecrets: { ADMIN_TOKEN: true, TICKET_HMAC_SECRET: true },
    },
  };
  const authorization = { assertArtifact: vi.fn(() => undefined) };
  const inspectWorker = vi.fn(
    async (
      input: Parameters<
        NonNullable<
          NonNullable<ProductionAdoptionProviderFactoryOverrides["adapters"]>["inspectWorker"]
        >
      >[0],
    ) => ({
      accountId: workerTarget.accountId,
      workerName: workerTarget.workerName,
      deploymentId: input.expectedBaselineDeploymentId,
      versionId: state.cloudflare.traffic[0].versionId,
      migrationTag: "v1" as const,
      requiredSecretBindingNames: ["ADMIN_TOKEN", "TICKET_HMAC_SECRET"],
      secretValuesObservable: false as const,
    }),
  );
  const overrides: ProductionAdoptionProviderFactoryOverrides = {
    adapters: { inspectWorker },
    createWorkerTransport: () => ({ dispatch: async () => ({}) }),
    inspectCloudflare: vi.fn(async () => state.cloudflare),
    inspectNetlify: vi.fn(async () => state.netlify),
    verifyAncestor: vi.fn(async () => undefined),
    verifySource: vi.fn(async () => ({
      source: prepared.source,
      configuration: releaseConfigSchema.parse(configuration),
    })),
    verifyWorkerArtifacts: vi.fn(async () => manifest),
  };
  const input = {
    artifactDirectory,
    authorization,
    configuration,
    prepared,
    repositoryRoot,
    smokeOutputDirectory,
  };
  return { authorization, input, inspectWorker, manifest, overrides, state };
}

const uploadResult = (value: Awaited<ReturnType<typeof fixture>>) =>
  productionResultsSchema.parse({
    uploadedWorker: {
      accountId: "cloudflare-account",
      artifactManifestSha256: value.input.prepared.artifacts.worker.sha256,
      baselineDeploymentId: "baseline-worker-deployment",
      migrationPolicy: { artifactTag: "v1", change: "none", expectedCurrentTag: "v1" },
      scriptEtag: "3".repeat(64),
      status: "uploaded",
      versionId: "uploaded-worker-version",
      workerName: "production-worker",
    },
  }).uploadedWorker!;

it("returns attributable locked production state through a Worker-only provider surface", async () => {
  const value = await fixture();
  const dependencies = await createProductionAdoptionProviderDependencies(
    value.input,
    value.overrides,
  );

  await expect(dependencies.inspect()).resolves.toEqual({
    pair: {
      netlifyDeployId: "netlify-deploy",
      workerDeploymentId: "baseline-worker-deployment",
      workerVersionId: "baseline-worker-version",
    },
    netlify: {
      branch: "main",
      context: "production",
      publishLocked: true,
      publishedDeployId: "netlify-deploy",
      siteId: "production-site",
      sourceCommit: "9".repeat(40),
    },
    worker: {
      accountId: "cloudflare-account",
      deploymentId: "baseline-worker-deployment",
      migrationTag: "v1",
      requiredSecretBindingNames: ["ADMIN_TOKEN", "TICKET_HMAC_SECRET"],
      secretValuesObservable: false,
      versionId: "baseline-worker-version",
      workerName: "production-worker",
    },
  });
  expect(Object.keys(dependencies).sort()).toEqual([
    "activateWorker",
    "inspect",
    "reconcile",
    "uploadWorker",
    "verifyPair",
    "verifyRetained",
  ]);
  expect(value.overrides.verifyAncestor).toHaveBeenCalledWith(
    value.input.repositoryRoot,
    "9".repeat(40),
    value.input.prepared.source.candidate,
  );
});

it("blocks an unlocked or unattributable Netlify publication before creating Worker transport", async () => {
  const value = await fixture();
  value.state.netlify.publishLocked = false;
  const createWorkerTransport = vi.fn(() => ({ dispatch: async () => ({}) }));
  value.overrides.createWorkerTransport = createWorkerTransport;

  await expect(
    createProductionAdoptionProviderDependencies(value.input, value.overrides),
  ).rejects.toThrow("inspection did not pass");
  expect(createWorkerTransport).not.toHaveBeenCalled();
  expect(value.authorization.assertArtifact).not.toHaveBeenCalled();
});

it("uses only the prepared Worker adapter operations and retains the initial baseline", async () => {
  const value = await fixture();
  const upload = uploadResult(value);
  type Upload = NonNullable<
    NonNullable<ProductionAdoptionProviderFactoryOverrides["adapters"]>["uploadWorker"]
  >;
  type Activate = NonNullable<
    NonNullable<ProductionAdoptionProviderFactoryOverrides["adapters"]>["activateWorker"]
  >;
  const uploadWorker = vi.fn<Upload>(async () => upload);
  const activateWorker = vi.fn<Activate>(async () => ({
    ...upload,
    deploymentId: "adopted-worker-deployment",
    status: "activated" as const,
  }));
  value.overrides.adapters = { ...value.overrides.adapters, activateWorker, uploadWorker };
  const dependencies = await createProductionAdoptionProviderDependencies(
    value.input,
    value.overrides,
  );
  const checkpoint = vi.fn(async () => undefined);

  await expect(dependencies.uploadWorker(checkpoint)).resolves.toEqual(upload);
  await expect(dependencies.activateWorker(upload, checkpoint)).resolves.toEqual({
    deploymentId: "adopted-worker-deployment",
    versionId: "uploaded-worker-version",
  });
  expect(uploadWorker.mock.calls[0]![0].expectedBaselineDeploymentId).toBe(
    "baseline-worker-deployment",
  );
  expect(activateWorker.mock.calls[0]![0].expectedBaselineDeploymentId).toBe(
    "baseline-worker-deployment",
  );
});

it("reconciles only exact retained response identifiers and verifies retained Worker evidence", async () => {
  const value = await fixture();
  const upload = uploadResult(value);
  const reconcileWorker = vi.fn(async (_input, reconciliation) => {
    if (reconciliation.phase.startsWith("version-upload")) return upload;
    return {
      ...upload,
      deploymentId: "adopted-worker-deployment",
      status: "activated" as const,
    };
  });
  const verifyRetainedWorker = vi.fn(async () => undefined);
  value.overrides.adapters = {
    ...value.overrides.adapters,
    reconcileWorker,
    verifyRetainedWorker,
  };
  const timestamp = new Date(0).toISOString();
  const previous = productionAdoptionRecordSchema.parse({
    schemaVersion: 1,
    operation: "production-adoption",
    source: {
      promotionPr: 1,
      candidate: "8".repeat(40),
      promotionCommit: value.input.prepared.source.candidate,
      tree: value.input.prepared.source.tree,
      configurationSha256: artifactHash(
        JSON.stringify(releaseConfigSchema.parse(value.input.configuration)),
      ),
      productionConfigurationFingerprint: value.input.prepared.source.configurationFingerprint,
      staging: {
        runId: 2,
        workflowCommit: "7".repeat(40),
        artifactId: 3,
        artifactDigest: `sha256:${"6".repeat(64)}`,
        artifactSizeInBytes: 100,
        artifactExpiresAt: "2026-09-19T00:00:00.000Z",
        evidenceSha256: "5".repeat(64),
      },
    },
    preparationSha256: artifactHash(
      JSON.stringify(preparedReleaseSchema.parse(value.input.prepared)),
    ),
    originalRunId: 4,
    runIds: [4],
    createdAt: timestamp,
    updatedAt: timestamp,
    inspection: await createProductionAdoptionProviderDependencies(
      value.input,
      value.overrides,
    ).then((dependencies) => dependencies.inspect()),
    migration: { artifactTag: "v1", change: "none", expectedCurrentTag: "v1" },
    stages: {
      inspect: "passed",
      "upload-worker": "blocked",
      "activate-worker": "pending",
      "verify-pair": "pending",
    },
    results: {},
    journal: [
      {
        step: "upload-worker",
        at: timestamp,
        value: {
          accountId: "cloudflare-account",
          artifactManifestSha256: value.input.prepared.artifacts.worker.sha256,
          baselineDeploymentId: "baseline-worker-deployment",
          migrationPolicy: { artifactTag: "v1", change: "none", expectedCurrentTag: "v1" },
          phase: "version-upload-response-received",
          versionId: "uploaded-worker-version",
          workerName: "production-worker",
        },
      },
    ],
    outcome: "blocked",
    recovery: "inspect-recorded-adoption-before-forward-recovery",
  });
  const dependencies = await createProductionAdoptionProviderDependencies(
    { ...value.input, previous },
    value.overrides,
  );

  await expect(dependencies.reconcile("upload-worker", previous)).resolves.toEqual({
    uploadedWorker: upload,
  });
  expect(reconcileWorker.mock.calls.at(-1)?.[1]).toEqual({
    phase: "version-upload-response-received",
    versionId: "uploaded-worker-version",
  });
  const withUpload = productionAdoptionRecordSchema.parse({
    ...previous,
    stages: { ...previous.stages, "upload-worker": "passed" },
    results: { uploadedWorker: upload },
  });
  await dependencies.verifyRetained(withUpload);
  expect(verifyRetainedWorker).toHaveBeenCalledWith(
    expect.objectContaining({ expectedBaselineDeploymentId: "baseline-worker-deployment" }),
    upload,
    undefined,
    expect.anything(),
  );

  const remotelyActivated = productionAdoptionRecordSchema.parse({
    ...withUpload,
    stages: { ...withUpload.stages, "activate-worker": "blocked" },
    journal: [
      ...withUpload.journal,
      {
        step: "activate-worker",
        at: timestamp,
        value: {
          accountId: "cloudflare-account",
          artifactManifestSha256: value.input.prepared.artifacts.worker.sha256,
          baselineDeploymentId: "baseline-worker-deployment",
          migrationPolicy: { artifactTag: "v1", change: "none", expectedCurrentTag: "v1" },
          phase: "pending-activation",
          versionId: upload.versionId,
          workerName: "production-worker",
        },
      },
    ],
  });
  value.state.cloudflare.deploymentId = "adopted-worker-deployment";
  value.state.cloudflare.traffic = [{ versionId: upload.versionId, percentage: 100 }];
  const resumed = await createProductionAdoptionProviderDependencies(
    { ...value.input, previous: remotelyActivated },
    value.overrides,
  );
  await expect(resumed.reconcile("activate-worker", remotelyActivated)).resolves.toEqual({
    activatedWorker: {
      deploymentId: "adopted-worker-deployment",
      versionId: "uploaded-worker-version",
    },
  });
  expect(reconcileWorker.mock.calls.at(-1)?.[1]).toEqual({
    phase: "activation-pending",
    upload,
  });
});

it("writes only a sanitized unique production smoke report", async () => {
  const value = await fixture();
  value.overrides.uniqueId = () => "adoption-smoke";
  value.overrides.runSmoke = vi.fn(
    async () =>
      ({
        schemaVersion: 1,
        operation: "collaboration-smoke",
        outcome: "passed",
        environment: "production",
        configuration: { source: "default", fingerprint: "4".repeat(64) },
        checks: [{ id: "pair.live", outcome: "passed", summary: "Pair passed." }],
        usage: { uploads: 1, captureRequested: true, captureRequests: 1 },
        rawProviderValue: "must-not-be-written",
      }) as never,
  );
  const dependencies = await createProductionAdoptionProviderDependencies(
    value.input,
    value.overrides,
  );

  await expect(dependencies.verifyPair()).resolves.toBe(true);
  const report = await readFile(
    join(value.input.smokeOutputDirectory, "pair-adoption-smoke.json"),
    "utf8",
  );
  expect(report).not.toContain("must-not-be-written");
});
