import { describe, expect, it } from "vitest";
import { artifactHash } from "./artifact-contract.ts";
import { preparedReleaseSchema } from "./prepare.ts";
import {
  productionAdoptionRecordSchema,
  productionAdoptionSteps,
} from "./production-adoption-record.ts";
import { recoveryTargetSchema, validateAdoptionRecoveryArtifact } from "./recovery-target.ts";

function fixture() {
  const prepared = preparedReleaseSchema.parse({
    schemaVersion: 1,
    operation: "prepare",
    outcome: "passed",
    source: {
      candidate: "a".repeat(40),
      tree: "b".repeat(40),
      environment: "production",
      configurationFingerprint: "c".repeat(64),
    },
    toolchain: { bun: "1.3.14" },
    artifacts: {
      netlify: { directory: "netlify", sha256: "d".repeat(64) },
      worker: { directory: "worker", sha256: "e".repeat(64) },
    },
  });
  const pair = {
    netlifyDeployId: "retained-netlify",
    workerDeploymentId: "new-deployment",
    workerVersionId: "new-version",
  };
  const migration = { artifactTag: "v1", expectedCurrentTag: "v1", change: "none" };
  const record = productionAdoptionRecordSchema.parse({
    schemaVersion: 1,
    operation: "production-adoption",
    source: {
      promotionPr: 58,
      candidate: "f".repeat(40),
      promotionCommit: prepared.source.candidate,
      tree: prepared.source.tree,
      configurationSha256: "1".repeat(64),
      productionConfigurationFingerprint: prepared.source.configurationFingerprint,
      staging: {
        runId: 60,
        workflowCommit: "f".repeat(40),
        artifactId: 61,
        artifactDigest: `sha256:${"2".repeat(64)}`,
        artifactSizeInBytes: 100,
        artifactExpiresAt: "2026-09-19T00:00:00Z",
        evidenceSha256: "3".repeat(64),
      },
    },
    preparationSha256: artifactHash(JSON.stringify(prepared)),
    originalRunId: 70,
    runIds: [70, 71],
    createdAt: "2026-09-12T00:00:00.000Z",
    updatedAt: "2026-09-12T01:00:00.000Z",
    inspection: {
      pair: { ...pair, workerDeploymentId: "old-deployment", workerVersionId: "old-version" },
      netlify: {
        siteId: "site",
        publishedDeployId: pair.netlifyDeployId,
        sourceCommit: "4".repeat(40),
        branch: "main",
        context: "production",
        publishLocked: true,
      },
      worker: {
        accountId: "account",
        workerName: "worker",
        deploymentId: "old-deployment",
        versionId: "old-version",
        migrationTag: "v1",
        requiredSecretBindingNames: ["ADMIN_TOKEN", "TICKET_HMAC_SECRET"],
        secretValuesObservable: false,
      },
    },
    migration,
    stages: Object.fromEntries(productionAdoptionSteps.map((step) => [step, "passed"])),
    results: {
      uploadedWorker: {
        accountId: "account",
        workerName: "worker",
        artifactManifestSha256: prepared.artifacts.worker.sha256,
        baselineDeploymentId: "old-deployment",
        migrationPolicy: migration,
        scriptEtag: "5".repeat(32),
        status: "uploaded",
        versionId: pair.workerVersionId,
      },
      activatedWorker: { deploymentId: pair.workerDeploymentId, versionId: pair.workerVersionId },
    },
    journal: [],
    observedPair: pair,
    adoptedPair: pair,
    proposedBaseline: {
      version: 1,
      environment: "production",
      providers: {
        netlify: {
          siteId: "site",
          sourceCommit: "4".repeat(40),
          publishedDeployId: pair.netlifyDeployId,
          publishLocked: true,
        },
        cloudflare: {
          accountId: "account",
          workerName: "worker",
          sourceCommit: prepared.source.candidate,
          deploymentId: pair.workerDeploymentId,
          traffic: [{ versionId: pair.workerVersionId, percentage: 100 }],
        },
      },
    },
    outcome: "passed",
    recovery: "none",
  });
  const target = recoveryTargetSchema.parse({
    schemaVersion: 1,
    operation: "recovery-target",
    configurationFingerprint: record.source.configurationSha256,
    pair,
    netlifySourceCommit: record.inspection!.netlify.sourceCommit,
    workerSourceCommit: prepared.source.candidate,
    workerArtifactKind: "production-adoption",
    workerArtifactRunId: 71,
    workerArtifactSha256: prepared.artifacts.worker.sha256,
    workerScriptEtag: record.results.uploadedWorker!.scriptEtag,
  });
  return { prepared, record, target };
}

describe("adoption recovery targets", () => {
  it("accepts the completed adopted Worker and independently attributed retained Netlify", () => {
    const { target, record, prepared } = fixture();
    expect(() => validateAdoptionRecoveryArtifact(target, record, prepared)).not.toThrow();
  });
  it("accepts a restored deployment of the exact adopted Worker version", () => {
    const { target, record, prepared } = fixture();
    target.pair.workerDeploymentId = "restored-deployment";
    expect(() => validateAdoptionRecoveryArtifact(target, record, prepared)).not.toThrow();
  });
  it.each([
    ["workerArtifactKind", undefined],
    ["netlifyArtifactSha256", "d".repeat(64)],
    ["workerArtifactRunId", 70],
    ["workerSourceCommit", "6".repeat(40)],
    ["netlifySourceCommit", "6".repeat(40)],
    ["configurationFingerprint", "6".repeat(64)],
    ["workerArtifactSha256", "6".repeat(64)],
    ["workerScriptEtag", "6".repeat(32)],
  ])("rejects mismatched %s", (key, value) => {
    const { target, record, prepared } = fixture();
    expect(() =>
      validateAdoptionRecoveryArtifact({ ...target, [key]: value }, record, prepared),
    ).toThrow();
  });
  it.each(["netlifyDeployId", "workerVersionId"] as const)("rejects a different %s", (key) => {
    const { target, record, prepared } = fixture();
    target.pair[key] = "different";
    expect(() => validateAdoptionRecoveryArtifact(target, record, prepared)).toThrow();
  });
  it("rejects an incomplete adoption even if its proposed pair matches", () => {
    const { target, record, prepared } = fixture();
    record.stages["verify-pair"] = "failed";
    expect(() => validateAdoptionRecoveryArtifact(target, record, prepared)).toThrow();
  });
  it("rejects a changed prepared bundle", () => {
    const { target, record, prepared } = fixture();
    prepared.artifacts.worker.sha256 = "6".repeat(64);
    expect(() => validateAdoptionRecoveryArtifact(target, record, prepared)).toThrow();
  });
});
