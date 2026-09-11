import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";

import { artifactHash } from "./artifact-contract.ts";
import { readReleaseJson } from "./files.ts";
import {
  downloadGitHubArtifact,
  extractVerifiedGitHubArtifact,
  type VerifiedCompletedRecovery,
  type VerifiedProductionRun,
  type VerifyCompletedRecovery,
} from "./github-release.ts";
import { productionRecordSchema, type ProductionRecord } from "./production-record.ts";
import { recoveryPreflightSchema, type RecoveryPreflight } from "./recovery-preflight.ts";
import { recoveryRecordSchema, recoverySteps, type RecoveryRecord } from "./recovery-record.ts";
import { recoveryTargetSchema, type RecoveryTarget } from "./recovery-target.ts";

const samePair = (
  left: RecoveryRecord["startingPair"],
  right: RecoveryRecord["startingPair"],
): boolean =>
  left.netlifyDeployId === right.netlifyDeployId &&
  left.workerDeploymentId === right.workerDeploymentId &&
  left.workerVersionId === right.workerVersionId;

const strictlyIncreasing = (runIds: readonly number[]): boolean =>
  new Set(runIds).size === runIds.length &&
  runIds.every((runId, index) => index === 0 || runId > runIds[index - 1]);

export function verifyCompletedRecoveryEvidence(input: {
  run: VerifiedProductionRun;
  preflight: RecoveryPreflight;
  recovery: RecoveryRecord;
  source: ProductionRecord;
  target: RecoveryTarget;
}): VerifiedCompletedRecovery {
  const { preflight, recovery, run, source, target } = input;
  const sourceSha256 = artifactHash(JSON.stringify(source));
  const targetSha256 = artifactHash(JSON.stringify(target));
  const recoveryPlanSha256 = artifactHash(
    JSON.stringify({
      target,
      startingPair: preflight.startingPair,
      targetArtifact: preflight.targetArtifact,
    }),
  );
  const previousRecoveryRunId = recovery.recoveryRunIds.at(-2);
  if (
    source.runIds[0] !== source.originalRunId ||
    !strictlyIncreasing(source.runIds) ||
    !strictlyIncreasing(recovery.recoveryRunIds) ||
    recovery.recoveryRunIds.some((runId) => runId <= recovery.sourceProductionRunId) ||
    recovery.outcome !== "passed" ||
    recovery.environment !== "production" ||
    recovery.failure !== undefined ||
    recovery.recoveryRunIds.at(-1) !== run.runId ||
    recovery.sourceProductionRunId !== source.runIds.at(-1) ||
    recovery.sourceProductionRecordSha256 !== sourceSha256 ||
    recoverySteps.some((step) => recovery.stages[step] !== "passed") ||
    preflight.runId !== run.runId ||
    preflight.workflowCommit !== run.headSha ||
    preflight.sourceRunId !== recovery.sourceProductionRunId ||
    preflight.sourceSha256 !== sourceSha256 ||
    preflight.targetRunId !== target.workerArtifactRunId ||
    preflight.targetSha256 !== targetSha256 ||
    preflight.recoveryPlanSha256 !== recoveryPlanSha256 ||
    preflight.recoveryPlanSha256 !== recovery.recoveryPlanSha256 ||
    preflight.resumeRunId !== previousRecoveryRunId ||
    !samePair(preflight.startingPair, recovery.startingPair) ||
    target.configurationFingerprint !== source.configurationFingerprint ||
    !samePair(target.pair, source.priorPair) ||
    !samePair(recovery.targetPair, source.priorPair) ||
    !recovery.targetEvidence ||
    !samePair(recovery.targetEvidence.requested, recovery.targetPair) ||
    !samePair(recovery.targetEvidence.expectedCurrent, recovery.startingPair) ||
    !recovery.observedPair ||
    !recovery.recoveredPair ||
    !samePair(recovery.observedPair, recovery.recoveredPair) ||
    recovery.recoveredPair.netlifyDeployId !== source.priorPair.netlifyDeployId ||
    recovery.recoveredPair.workerVersionId !== source.priorPair.workerVersionId ||
    recovery.results.netlify?.publishedDeployId !== recovery.recoveredPair.netlifyDeployId ||
    recovery.results.worker?.deploymentId !== recovery.recoveredPair.workerDeploymentId ||
    recovery.results.worker.versionId !== recovery.recoveredPair.workerVersionId
  ) {
    throw new Error("Recovery completion evidence differs.");
  }
  return {
    outcome: "passed",
    sourceProductionRunId: recovery.sourceProductionRunId,
    recoveryRunIds: recovery.recoveryRunIds,
  };
}

export function completedRecoveryVerifier(
  repositoryRoot: string,
  token: string,
): VerifyCompletedRecovery {
  return async ({ run, artifact }) => {
    const parent = await mkdtemp(resolve(tmpdir(), "release-recovery-inspection-"));
    try {
      const directory = resolve(parent, "evidence");
      const bytes = await downloadGitHubArtifact({
        token,
        artifactId: artifact.artifactId,
        expectedDigest: artifact.digest,
        expectedSizeInBytes: artifact.sizeInBytes,
      });
      await extractVerifiedGitHubArtifact(bytes, directory, repositoryRoot);
      const [preflight, recovery, source, target] = await Promise.all([
        readReleaseJson(resolve(directory, "recovery-preflight.json"), recoveryPreflightSchema),
        readReleaseJson(resolve(directory, "run/recovery.json"), recoveryRecordSchema),
        readReleaseJson(resolve(directory, "source/run/production.json"), productionRecordSchema),
        readReleaseJson(resolve(directory, "recovery-target.json"), recoveryTargetSchema),
      ]);
      return verifyCompletedRecoveryEvidence({ preflight, recovery, run, source, target });
    } finally {
      await rm(parent, { recursive: true, force: true });
    }
  };
}
