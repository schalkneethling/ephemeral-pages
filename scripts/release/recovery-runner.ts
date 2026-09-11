import { mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import { artifactHash, assertExternalArtifactDirectory } from "./artifact-contract.ts";
import { createAtomicJsonStore } from "./bootstrap-safety.ts";
import {
  pairSchema,
  productionRecordSchema,
  providerCheckpointSchema,
  type ProductionRecord,
} from "./production-record.ts";
import {
  recoveryRecordSchema,
  recoveryTargetEvidenceSchema,
  type RecoveryTargetEvidenceRecord,
  recoverySteps,
  type RecoveryRecord,
  type RecoveryStep,
} from "./recovery-record.ts";
import type { DeploymentPair } from "./rehearsal.ts";

export type RecoveryCheckpoint = (value: unknown) => Promise<void>;
export type RecoveryDependencies = {
  verifyTargets(): Promise<RecoveryTargetEvidenceRecord>;
  inspect(): Promise<DeploymentPair>;
  restoreNetlify(checkpoint: RecoveryCheckpoint): Promise<{ publishedDeployId: string }>;
  restoreWorker(
    checkpoint: RecoveryCheckpoint,
  ): Promise<{ deploymentId: string; versionId: string }>;
  reconcile(
    step: "restore-netlify" | "restore-worker",
    record: RecoveryRecord,
  ): Promise<RecoveryRecord["results"]>;
  verifyTransition(): Promise<boolean>;
  verifyPair(): Promise<boolean>;
};
export type RecoveryRunInput = {
  environment: "production";
  repositoryRoot: string;
  reportDirectory: string;
  source: ProductionRecord;
  sourceProductionRunId: number;
  recoveryPlanSha256: string;
  currentRunId: number;
  startingPair: DeploymentPair;
  previous?: RecoveryRecord;
};
const same = (a: DeploymentPair, b: DeploymentPair) =>
  a.netlifyDeployId === b.netlifyDeployId &&
  a.workerDeploymentId === b.workerDeploymentId &&
  a.workerVersionId === b.workerVersionId;
export const expectedRecoveryPair = (record: RecoveryRecord): DeploymentPair => ({
  netlifyDeployId: record.results.netlify?.publishedDeployId ?? record.startingPair.netlifyDeployId,
  workerDeploymentId: record.results.worker?.deploymentId ?? record.startingPair.workerDeploymentId,
  workerVersionId: record.results.worker?.versionId ?? record.startingPair.workerVersionId,
});

// Provider dependencies must reconcile uncertain source-release writes and bind
// startingPair to live state before being handed to this runner. No guessed IDs.
export async function runRecovery(
  input: RecoveryRunInput,
  dependencies: RecoveryDependencies,
): Promise<RecoveryRecord> {
  const source = productionRecordSchema.parse(input.source);
  if (
    source.runIds.at(-1) !== input.sourceProductionRunId ||
    source.runIds.includes(input.currentRunId)
  )
    throw new Error("Recovery source lineage differs.");
  const sourceProductionRecordSha256 = artifactHash(JSON.stringify(source));
  const startingPair = pairSchema.parse(input.startingPair);
  const targetPair = source.priorPair;
  let record = input.previous
    ? recoveryRecordSchema.parse(input.previous)
    : recoveryRecordSchema.parse({
        schemaVersion: 1,
        operation: "production-recovery",
        environment: input.environment,
        sourceProductionRunId: input.sourceProductionRunId,
        sourceProductionRecordSha256,
        recoveryPlanSha256: input.recoveryPlanSha256,
        startingPair,
        targetPair,
        outcome: "pending",
        stages: Object.fromEntries(recoverySteps.map((step) => [step, "pending"])),
        results: {},
        journal: [],
        recoveryRunIds: [input.currentRunId],
      });
  if (input.previous) {
    if (!["blocked", "failed", "running"].includes(record.outcome))
      throw new Error("Recovery is not unresolved.");
    let incomplete = false;
    for (const step of recoverySteps) {
      const outcome = record.stages[step];
      if (outcome === "not-applicable" || (incomplete && outcome !== "pending"))
        throw new Error("Recovery stages are out of order.");
      if (outcome !== "passed") incomplete = true;
    }
    if (
      record.environment !== input.environment ||
      record.sourceProductionRunId !== input.sourceProductionRunId ||
      record.sourceProductionRecordSha256 !== sourceProductionRecordSha256 ||
      record.recoveryPlanSha256 !== input.recoveryPlanSha256 ||
      !same(record.startingPair, startingPair) ||
      !same(record.targetPair, targetPair) ||
      record.recoveryRunIds.includes(input.currentRunId) ||
      new Set(record.recoveryRunIds).size !== record.recoveryRunIds.length
    )
      throw new Error("Recovery evidence differs.");
    if (
      (record.stages["restore-netlify"] === "passed") !== Boolean(record.results.netlify) ||
      (record.stages["restore-worker"] === "passed") !== Boolean(record.results.worker)
    )
      throw new Error("Recovery result missing or inconsistent.");
    record.recoveryRunIds.push(input.currentRunId);
  }
  const validateResults = () => {
    if (
      record.results.netlify &&
      record.results.netlify.publishedDeployId !== targetPair.netlifyDeployId
    )
      throw new Error("Restored Netlify target differs.");
    if (record.results.worker && record.results.worker.versionId !== targetPair.workerVersionId)
      throw new Error("Restored Worker target differs.");
  };
  validateResults();
  await assertExternalArtifactDirectory(input.repositoryRoot, input.reportDirectory);
  await mkdir(input.reportDirectory, { mode: 0o700 });
  const store = createAtomicJsonStore<RecoveryRecord>(
    resolve(input.reportDirectory, "recovery.json"),
    1024 * 1024,
    () => new Error("Cannot persist recovery evidence."),
  );
  const save = () => store.save(recoveryRecordSchema.parse(record));
  record.outcome = "running";
  delete record.recoveredPair;
  await save();
  let active: RecoveryStep = "inspect";
  const checkpoint: RecoveryCheckpoint = async (value) => {
    record.journal.push({ step: active, value: providerCheckpointSchema.parse(value) });
    await save();
  };
  const inspect = async () => {
    delete record.observedPair;
    record.observedPair = pairSchema.parse(await dependencies.inspect());
    if (!same(record.observedPair, expectedRecoveryPair(record)))
      throw new Error("Unexpected live pair.");
  };
  try {
    for (const step of ["restore-netlify", "restore-worker"] as const) {
      if (!["running", "blocked", "failed"].includes(record.stages[step])) continue;
      active = step;
      const result = await dependencies.reconcile(step, record);
      const key = step === "restore-netlify" ? "netlify" : "worker";
      if (Object.keys(result).length !== 1 || !result[key])
        throw new Error("Ambiguous recovery result.");
      record.results = { ...record.results, ...result };
      validateResults();
      record.stages[step] = "passed";
      await save();
    }
    active = "inspect";
    record.targetEvidence = recoveryTargetEvidenceSchema.parse(await dependencies.verifyTargets());
    if (
      !same(record.targetEvidence.requested, targetPair) ||
      !same(record.targetEvidence.expectedCurrent, startingPair)
    )
      throw new Error("Recovery target evidence differs.");
    await inspect();
    record.stages.inspect = "passed";
    await save();
    for (const step of recoverySteps.slice(1)) {
      active = step;
      if (record.stages[step] === "passed") continue;
      await inspect();
      record.stages[step] = "running";
      await save();
      if (step === "restore-netlify") {
        record.results.netlify =
          record.startingPair.netlifyDeployId === targetPair.netlifyDeployId
            ? { publishedDeployId: targetPair.netlifyDeployId }
            : await dependencies.restoreNetlify(checkpoint);
      } else if (step === "restore-worker") {
        record.results.worker =
          record.startingPair.workerVersionId === targetPair.workerVersionId
            ? {
                deploymentId: record.startingPair.workerDeploymentId,
                versionId: targetPair.workerVersionId,
              }
            : await dependencies.restoreWorker(checkpoint);
      } else if (step === "verify-transition") {
        if (!(await dependencies.verifyTransition()))
          throw new Error("Recovery transition verification failed.");
      } else if (!(await dependencies.verifyPair()))
        throw new Error("Recovery pair verification failed.");
      validateResults();
      // Persist returned IDs before any readback that might fail.
      record.stages[step] = "passed";
      await save();
      await inspect();
    }
    record.recoveredPair = pairSchema.parse(record.observedPair);
    if (
      record.recoveredPair.netlifyDeployId !== targetPair.netlifyDeployId ||
      record.recoveredPair.workerVersionId !== targetPair.workerVersionId
    )
      throw new Error("Recovery target differs.");
    record.outcome = "passed";
    delete record.failure;
  } catch (error) {
    record.outcome = "blocked";
    // Preserve completed mutation results after a readback failure.
    if (record.stages[active] !== "passed") record.stages[active] = "blocked";
    const kind =
      typeof error === "object" && error !== null && "kind" in error ? error.kind : "unknown";
    record.failure = {
      stage: active,
      kind: ["verification", "ambiguous", "checkpoint", "preflight"].includes(String(kind))
        ? (kind as "verification")
        : "unknown",
    };
  }
  await save();
  return record;
}
