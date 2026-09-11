import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, expect, it } from "vitest";

import type { PreparedRelease } from "./prepare.ts";
import {
  productionAdoptionRecordSchema,
  validateCompletedAdoption,
  type ProductionAdoptionInspection,
} from "./production-adoption-record.ts";
import {
  runProductionAdoption,
  type ProductionAdoptionDependencies,
  type ProductionAdoptionRunInput,
} from "./production-adoption-runner.ts";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

const fixture = async () => {
  const root = await mkdtemp(join(tmpdir(), "production-adoption-runner-"));
  roots.push(root);
  const promotionCommit = "a".repeat(40);
  const prepared: PreparedRelease = {
    schemaVersion: 1,
    operation: "prepare",
    outcome: "passed",
    source: {
      candidate: promotionCommit,
      tree: "b".repeat(40),
      environment: "production",
      configurationFingerprint: "c".repeat(64),
    },
    toolchain: { bun: "1.3.14" },
    artifacts: {
      netlify: { directory: "netlify", sha256: "d".repeat(64) },
      worker: { directory: "worker", sha256: "e".repeat(64) },
    },
  };
  const source = {
    promotionPr: 10,
    candidate: "f".repeat(40),
    promotionCommit,
    tree: prepared.source.tree,
    configurationSha256: "1".repeat(64),
    productionConfigurationFingerprint: prepared.source.configurationFingerprint,
    staging: {
      runId: 20,
      workflowCommit: "f".repeat(40),
      artifactId: 30,
      artifactDigest: `sha256:${"2".repeat(64)}` as const,
      artifactSizeInBytes: 1024,
      artifactExpiresAt: "2026-09-19T00:00:00Z",
      evidenceSha256: "3".repeat(64),
    },
  };
  const originalPair = {
    netlifyDeployId: "netlify-current",
    workerDeploymentId: "worker-current-deployment",
    workerVersionId: "worker-current-version",
  };
  const activatedPair = {
    netlifyDeployId: originalPair.netlifyDeployId,
    workerDeploymentId: "worker-adopted-deployment",
    workerVersionId: "worker-adopted-version",
  };
  let pair = { ...originalPair };
  const calls: string[] = [];
  const inspection = (): ProductionAdoptionInspection => ({
    pair: { ...pair },
    netlify: {
      siteId: "production-site",
      publishedDeployId: pair.netlifyDeployId,
      sourceCommit: "4".repeat(40),
      branch: "main",
      context: "production",
      publishLocked: true,
    },
    worker: {
      accountId: "worker-account",
      workerName: "production-worker",
      deploymentId: pair.workerDeploymentId,
      versionId: pair.workerVersionId,
      migrationTag: "v1",
      requiredSecretBindingNames: ["ADMIN_TOKEN", "TICKET_HMAC_SECRET"],
      secretValuesObservable: false,
    },
  });
  const uploaded = {
    accountId: "worker-account",
    artifactManifestSha256: prepared.artifacts.worker.sha256,
    baselineDeploymentId: originalPair.workerDeploymentId,
    migrationPolicy: {
      artifactTag: "v1" as const,
      expectedCurrentTag: "v1" as const,
      change: "none" as const,
    },
    scriptEtag: "5".repeat(32),
    status: "uploaded" as const,
    versionId: activatedPair.workerVersionId,
    workerName: "production-worker",
  };
  const dependencies: ProductionAdoptionDependencies = {
    inspect: async () => {
      calls.push("inspect");
      return inspection();
    },
    verifyRetained: async () => {
      calls.push("verify-retained");
    },
    uploadWorker: async (checkpoint) => {
      calls.push("upload");
      await checkpoint({ phase: "pending-version-upload" });
      await checkpoint({
        phase: "version-upload-response-received",
        versionId: uploaded.versionId,
      });
      return uploaded;
    },
    activateWorker: async (_upload, checkpoint) => {
      calls.push("activate");
      await checkpoint({ phase: "pending-activation", versionId: uploaded.versionId });
      pair = { ...activatedPair };
      await checkpoint({
        phase: "activation-response-received",
        versionId: uploaded.versionId,
        deploymentId: activatedPair.workerDeploymentId,
      });
      return {
        deploymentId: activatedPair.workerDeploymentId,
        versionId: activatedPair.workerVersionId,
      };
    },
    reconcile: async (step) => {
      calls.push(`reconcile:${step}`);
      if (step === "upload-worker") return { uploadedWorker: uploaded };
      pair = { ...activatedPair };
      return {
        activatedWorker: {
          deploymentId: activatedPair.workerDeploymentId,
          versionId: activatedPair.workerVersionId,
        },
      };
    },
    verifyPair: async () => {
      calls.push("smoke");
      return true;
    },
  };
  const input: ProductionAdoptionRunInput = {
    repositoryRoot: root,
    reportDirectory: join(root, "..", `adoption-report-${Date.now()}`),
    prepared,
    source,
    currentRunId: 40,
  };
  return {
    activatedPair,
    calls,
    dependencies,
    getPair: () => pair,
    input,
    originalPair,
    prepared,
    setPair: (value: typeof pair) => {
      pair = value;
    },
  };
};

it("adopts only the Worker and emits the exact proposed baseline", async () => {
  const value = await fixture();
  const record = await runProductionAdoption(value.input, value.dependencies);
  expect(record.outcome).toBe("passed");
  expect(record.adoptedPair).toEqual(value.activatedPair);
  expect(record.proposedBaseline?.providers.netlify).toMatchObject({
    publishedDeployId: value.originalPair.netlifyDeployId,
    sourceCommit: "4".repeat(40),
    publishLocked: true,
  });
  expect(record.proposedBaseline?.providers.cloudflare).toMatchObject({
    sourceCommit: value.input.source.promotionCommit,
    deploymentId: value.activatedPair.workerDeploymentId,
    traffic: [{ versionId: value.activatedPair.workerVersionId, percentage: 100 }],
  });
  expect(record.results.heldNetlify).toBeUndefined();
  expect(record.results.publishedNetlify).toBeUndefined();
  expect(validateCompletedAdoption(record, value.prepared)).toEqual(record);
});

it("reconciles a retained activation result instead of rejecting or repeating it", async () => {
  const value = await fixture();
  const passed = await runProductionAdoption(value.input, value.dependencies);
  const previous = productionAdoptionRecordSchema.parse({
    ...passed,
    runIds: [40],
    stages: { ...passed.stages, "activate-worker": "blocked", "verify-pair": "pending" },
    outcome: "blocked",
    failure: { stage: "activate-worker", kind: "checkpoint" },
    observedPair: value.originalPair,
    adoptedPair: undefined,
    proposedBaseline: undefined,
    recovery: "inspect-recorded-adoption-before-forward-recovery",
  });
  value.calls.length = 0;
  value.setPair(value.activatedPair);
  const resumed = await runProductionAdoption(
    {
      ...value.input,
      currentRunId: 41,
      reportDirectory: join(value.input.reportDirectory, "resume"),
      previous,
    },
    value.dependencies,
  );
  expect(resumed.outcome).toBe("passed");
  expect(value.calls).toContain("reconcile:activate-worker");
  expect(value.calls).not.toContain("activate");
});

it("blocks a changed or unlocked Netlify deployment without a provider mutation", async () => {
  const value = await fixture();
  const originalInspect = value.dependencies.inspect.bind(value.dependencies);
  value.dependencies.inspect = async () => {
    const inspection = await originalInspect();
    return {
      ...inspection,
      netlify: { ...inspection.netlify, publishedDeployId: "substitute" },
    };
  };
  const record = await runProductionAdoption(value.input, value.dependencies);
  expect(record.outcome).toBe("failed");
  expect(value.calls).not.toContain("upload");
  expect(record.proposedBaseline).toBeUndefined();
});

it("rejects a substituted prepared configuration fingerprint at completion", async () => {
  const value = await fixture();
  const record = await runProductionAdoption(value.input, value.dependencies);
  const prepared = structuredClone(value.prepared);
  prepared.source.configurationFingerprint = "9".repeat(64);
  expect(() => validateCompletedAdoption(record, prepared)).toThrow(
    "Production adoption completion evidence differs.",
  );
});

it("rejects a substituted source fingerprint before creating provider dependencies", async () => {
  const value = await fixture();
  const input = structuredClone(value.input);
  input.source.productionConfigurationFingerprint = "9".repeat(64);
  await expect(runProductionAdoption(input, value.dependencies)).rejects.toThrow(
    "Production adoption source differs.",
  );
  expect(value.calls).toEqual([]);
});
