import { describe, expect, it } from "vitest";

import { artifactHash } from "./artifact-contract.ts";
import type { VerifiedProductionRun } from "./github-release.ts";
import { productionRecordSchema, productionSteps } from "./production-record.ts";
import { verifyCompletedRecoveryEvidence } from "./recovery-completion.ts";
import { recoveryPreflightSchema } from "./recovery-preflight.ts";
import { recoveryRecordSchema, recoverySteps } from "./recovery-record.ts";
import { recoveryTargetSchema } from "./recovery-target.ts";

const commit = "b".repeat(40);
const digest = "d".repeat(64);
const priorPair = {
  netlifyDeployId: "prior-netlify",
  workerDeploymentId: "prior-worker-deployment",
  workerVersionId: "prior-worker-version",
};
const startingPair = {
  netlifyDeployId: "candidate-netlify",
  workerDeploymentId: "candidate-worker-deployment",
  workerVersionId: "candidate-worker-version",
};

const fixture = () => {
  const source = productionRecordSchema.parse({
    schemaVersion: 1,
    operation: "production-release",
    approvalSha256: "a".repeat(64),
    candidate: "a".repeat(40),
    promotionCommit: commit,
    tree: "c".repeat(40),
    configurationFingerprint: "e".repeat(64),
    originalRunId: 80,
    runIds: [80, 90],
    preparationSha256: "f".repeat(64),
    createdAt: "2026-09-11T09:00:00.000Z",
    updatedAt: "2026-09-11T10:00:00.000Z",
    outcome: "blocked",
    priorPair,
    observedPair: startingPair,
    stages: Object.fromEntries(productionSteps.map((step) => [step, "pending"])),
    results: {},
    journal: [],
    recovery: "inspect-recorded-targets-before-recovery",
  });
  const sourceSha256 = artifactHash(JSON.stringify(source));
  const artifact = {
    artifactId: 500,
    digest: `sha256:${digest}`,
    sizeInBytes: 2048,
    expiresAt: "2026-09-18T10:00:00.000Z",
  };
  const target = recoveryTargetSchema.parse({
    schemaVersion: 1,
    operation: "recovery-target",
    configurationFingerprint: source.configurationFingerprint,
    pair: priorPair,
    netlifySourceCommit: "1".repeat(40),
    workerSourceCommit: "2".repeat(40),
    workerArtifactRunId: 70,
    workerArtifactSha256: "7".repeat(64),
    workerScriptEtag: "6".repeat(32),
  });
  const targetArtifact = { ...artifact, artifactId: 501 };
  const recoveryPlanSha256 = artifactHash(JSON.stringify({ target, startingPair, targetArtifact }));
  const recovery = recoveryRecordSchema.parse({
    schemaVersion: 1,
    operation: "production-recovery",
    environment: "production",
    sourceProductionRunId: 90,
    sourceProductionRecordSha256: sourceSha256,
    recoveryPlanSha256,
    recoveryRunIds: [99],
    startingPair,
    targetPair: priorPair,
    targetEvidence: {
      inspectionVersion: 2,
      inspectionSha256: "8".repeat(64),
      requested: priorPair,
      expectedCurrent: startingPair,
      netlifyIdentity: "source-commit",
      netlifyVariablesVerified: true,
      workerArtifactSha256: "7".repeat(64),
      workerMigrationTag: "v1",
      workerScriptEtag: "6".repeat(32),
      workerSecretBindingNames: ["WORKER_SECRET"],
      workerSecretValuesObservable: false,
    },
    observedPair: {
      ...priorPair,
      workerDeploymentId: "restored-worker-deployment",
    },
    recoveredPair: {
      ...priorPair,
      workerDeploymentId: "restored-worker-deployment",
    },
    outcome: "passed",
    stages: Object.fromEntries(recoverySteps.map((step) => [step, "passed"])),
    results: {
      netlify: { publishedDeployId: priorPair.netlifyDeployId },
      worker: {
        deploymentId: "restored-worker-deployment",
        versionId: priorPair.workerVersionId,
      },
    },
    journal: [],
  });
  const preflight = recoveryPreflightSchema.parse({
    schemaVersion: 1,
    operation: "recovery-preflight",
    runId: 99,
    sourceRunId: 90,
    workflowCommit: commit,
    sourceSha256,
    targetSha256: artifactHash(JSON.stringify(target)),
    recoveryPlanSha256,
    startingPair,
    evidenceArtifact: artifact,
    targetArtifact,
    targetRunId: 70,
  });
  const run: VerifiedProductionRun = {
    runId: 99,
    runAttempt: 1,
    workflowId: 10,
    workflowPath: ".github/workflows/release-production.yml",
    branch: "main",
    headSha: commit,
    createdAt: "2026-09-11T10:00:00.000Z",
    updatedAt: "2026-09-11T10:30:00.000Z",
  };
  return { preflight, recovery, run, source, target };
};

describe("completed recovery evidence", () => {
  it("binds a fresh recovery to its exact run, source, plan, and provider pairs", () => {
    const evidence = fixture();
    expect(verifyCompletedRecoveryEvidence(evidence)).toEqual({
      outcome: "passed",
      sourceProductionRunId: 90,
      recoveryRunIds: [99],
    });
  });

  it("binds a resumed recovery to the immediately preceding recovery run", () => {
    const evidence = fixture();
    evidence.recovery.recoveryRunIds.push(105);
    evidence.preflight.runId = 105;
    evidence.preflight.resumeRunId = 99;
    evidence.run.runId = 105;
    expect(verifyCompletedRecoveryEvidence(evidence).recoveryRunIds).toEqual([99, 105]);
  });

  it("rejects unversioned production target evidence at the record boundary", () => {
    const evidence = fixture();
    const raw = structuredClone(evidence.recovery) as unknown as {
      targetEvidence: { inspectionVersion?: 2 };
    };
    delete raw.targetEvidence.inspectionVersion;
    expect(() => recoveryRecordSchema.parse(raw)).toThrow();
  });

  it("rejects unversioned production target evidence passed directly", () => {
    const evidence = fixture();
    delete (evidence.recovery.targetEvidence as { inspectionVersion?: 2 }).inspectionVersion;
    expect(() => verifyCompletedRecoveryEvidence(evidence)).toThrow(
      "Recovery completion evidence differs.",
    );
  });

  it.each([
    (value: ReturnType<typeof fixture>) => {
      value.recovery.targetEvidence!.inspectionSha256 = "not-a-sha256-digest";
    },
    (value: ReturnType<typeof fixture>) => {
      value.preflight.workflowCommit = "0".repeat(40);
    },
    (value: ReturnType<typeof fixture>) => {
      value.preflight.resumeRunId = 98;
    },
    (value: ReturnType<typeof fixture>) => {
      value.preflight.targetArtifact.artifactId = 999;
    },
    (value: ReturnType<typeof fixture>) => {
      value.target.workerArtifactRunId = 71;
    },
    (value: ReturnType<typeof fixture>) => {
      value.source.runIds = [80, 85, 82, 90];
    },
    (value: ReturnType<typeof fixture>) => {
      value.recovery.targetPair = { ...priorPair, netlifyDeployId: "substitute" };
    },
    (value: ReturnType<typeof fixture>) => {
      value.recovery.targetEvidence!.requested = {
        ...priorPair,
        workerVersionId: "substitute",
      };
    },
    (value: ReturnType<typeof fixture>) => {
      value.recovery.observedPair = startingPair;
    },
    (value: ReturnType<typeof fixture>) => {
      value.recovery.failure = { stage: "verify-pair", kind: "verification" };
    },
  ])("rejects an incomplete or substituted completion chain", (mutate) => {
    const evidence = fixture();
    mutate(evidence);
    expect(() => verifyCompletedRecoveryEvidence(evidence)).toThrow(
      "Recovery completion evidence differs.",
    );
  });
});
