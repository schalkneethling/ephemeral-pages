import { mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import { z } from "zod/v4";

import { artifactHash, assertExternalArtifactDirectory } from "./artifact-contract.ts";
import { createAtomicJsonStore } from "./bootstrap-safety.ts";
import {
  digestSchema,
  pairSchema,
  providerCheckpointSchema,
  stageOutcomeSchema,
} from "./production-record.ts";
import {
  recoverySteps,
  recoveryStepSchema,
  stagingRecoveryTargetEvidenceSchema,
  type StagingRecoveryTargetEvidenceRecord,
  type RecoveryStep,
} from "./recovery-record.ts";
import type { DeploymentPair } from "./rehearsal.ts";
import type { ReleaseConfig } from "./schema.ts";
import {
  stagingRecoverySourceSchema,
  validateStagingRecoverySource,
  type StagingRecoverySource,
} from "./staging-recovery-source.ts";

export const stagingRecoveryRecordSchema = z.strictObject({
  schemaVersion: z.literal(1),
  operation: z.literal("staging-recovery"),
  environment: z.literal("staging"),
  sourceRehearsalRunId: z.number().int().positive(),
  sourceRehearsalSha256: digestSchema,
  targetRehearsalRunId: z.number().int().positive(),
  targetRehearsalSha256: digestSchema,
  sourceSha256: digestSchema,
  configurationFingerprint: digestSchema,
  recoveryPlanSha256: digestSchema,
  recoveryRunIds: z.array(z.number().int().positive()).min(1).max(100),
  startingPair: pairSchema,
  targetPair: pairSchema,
  targetEvidence: stagingRecoveryTargetEvidenceSchema.optional(),
  observedPair: pairSchema.optional(),
  recoveredPair: pairSchema.optional(),
  outcome: stageOutcomeSchema,
  stages: z.record(recoveryStepSchema, stageOutcomeSchema),
  results: z.strictObject({
    netlify: z.strictObject({ publishedDeployId: pairSchema.shape.netlifyDeployId }).optional(),
    worker: z
      .strictObject({
        deploymentId: pairSchema.shape.workerDeploymentId,
        versionId: pairSchema.shape.workerVersionId,
      })
      .optional(),
  }),
  journal: z
    .array(z.strictObject({ step: recoveryStepSchema, value: providerCheckpointSchema }))
    .max(1_000),
  failure: z
    .strictObject({
      stage: recoveryStepSchema,
      kind: z.enum(["verification", "ambiguous", "checkpoint", "preflight", "unknown"]),
    })
    .optional(),
});
export type StagingRecoveryRecord = z.infer<typeof stagingRecoveryRecordSchema>;

export type StagingRecoveryCheckpoint = (value: unknown) => Promise<void>;
export type StagingRecoveryDependencies = {
  inspect(): Promise<DeploymentPair>;
  reconcile(
    step: "restore-netlify" | "restore-worker",
    record: StagingRecoveryRecord,
  ): Promise<StagingRecoveryRecord["results"]>;
  restoreNetlify(checkpoint: StagingRecoveryCheckpoint): Promise<{ publishedDeployId: string }>;
  restoreWorker(
    checkpoint: StagingRecoveryCheckpoint,
  ): Promise<{ deploymentId: string; versionId: string }>;
  verifyPair(): Promise<boolean>;
  verifyTargets(): Promise<StagingRecoveryTargetEvidenceRecord>;
  verifyTransition(): Promise<boolean>;
};

export type StagingRecoveryRunInput = {
  configuration: ReleaseConfig;
  currentRunId: number;
  previous?: StagingRecoveryRecord;
  recoveryPlanSha256: string;
  reportDirectory: string;
  repositoryRoot: string;
  source: StagingRecoverySource;
  workerConfig: string;
};

const samePair = (left: DeploymentPair, right: DeploymentPair): boolean =>
  left.netlifyDeployId === right.netlifyDeployId &&
  left.workerDeploymentId === right.workerDeploymentId &&
  left.workerVersionId === right.workerVersionId;

export const expectedStagingRecoveryPair = (record: StagingRecoveryRecord): DeploymentPair => ({
  netlifyDeployId: record.results.netlify?.publishedDeployId ?? record.startingPair.netlifyDeployId,
  workerDeploymentId: record.results.worker?.deploymentId ?? record.startingPair.workerDeploymentId,
  workerVersionId: record.results.worker?.versionId ?? record.startingPair.workerVersionId,
});

export async function runStagingRecovery(
  input: StagingRecoveryRunInput,
  dependencies: StagingRecoveryDependencies,
): Promise<StagingRecoveryRecord> {
  const source = stagingRecoverySourceSchema.parse(input.source);
  const validated = validateStagingRecoverySource(source, input.configuration, input.workerConfig);
  if (
    !Number.isSafeInteger(input.currentRunId) ||
    input.currentRunId < 1 ||
    input.currentRunId <= source.source.workflow.runId ||
    input.currentRunId <= source.target.workflow.runId
  ) {
    throw new Error("Staging recovery run lineage differs.");
  }
  const sourceSha256 = artifactHash(JSON.stringify(source));
  const configurationFingerprint = artifactHash(JSON.stringify(input.configuration));
  const startingPair = pairSchema.parse(validated.startingPair);
  const targetPair = pairSchema.parse(validated.targetPair);
  let record = input.previous
    ? stagingRecoveryRecordSchema.parse(input.previous)
    : stagingRecoveryRecordSchema.parse({
        schemaVersion: 1,
        operation: "staging-recovery",
        environment: "staging",
        sourceRehearsalRunId: source.source.workflow.runId,
        sourceRehearsalSha256: validated.sourceRehearsalSha256,
        targetRehearsalRunId: source.target.workflow.runId,
        targetRehearsalSha256: validated.targetRehearsalSha256,
        sourceSha256,
        configurationFingerprint,
        recoveryPlanSha256: input.recoveryPlanSha256,
        recoveryRunIds: [input.currentRunId],
        startingPair,
        targetPair,
        outcome: "pending",
        stages: Object.fromEntries(recoverySteps.map((step) => [step, "pending"])),
        results: {},
        journal: [],
      });
  if (input.previous) {
    if (!["blocked", "failed", "running"].includes(record.outcome))
      throw new Error("Staging recovery is not unresolved.");
    let incomplete = false;
    for (const step of recoverySteps) {
      const outcome = record.stages[step];
      if (outcome === "not-applicable" || (incomplete && outcome !== "pending"))
        throw new Error("Staging recovery stages are out of order.");
      if (outcome !== "passed") incomplete = true;
    }
    if (
      record.sourceRehearsalRunId !== source.source.workflow.runId ||
      record.sourceRehearsalSha256 !== validated.sourceRehearsalSha256 ||
      record.targetRehearsalRunId !== source.target.workflow.runId ||
      record.targetRehearsalSha256 !== validated.targetRehearsalSha256 ||
      record.sourceSha256 !== sourceSha256 ||
      record.configurationFingerprint !== configurationFingerprint ||
      record.recoveryPlanSha256 !== input.recoveryPlanSha256 ||
      !samePair(record.startingPair, startingPair) ||
      !samePair(record.targetPair, targetPair) ||
      record.recoveryRunIds.includes(input.currentRunId) ||
      input.currentRunId <= record.recoveryRunIds.at(-1)! ||
      new Set(record.recoveryRunIds).size !== record.recoveryRunIds.length
    ) {
      throw new Error("Staging recovery evidence differs.");
    }
    if (
      (record.stages["restore-netlify"] === "passed") !== Boolean(record.results.netlify) ||
      (record.stages["restore-worker"] === "passed") !== Boolean(record.results.worker)
    ) {
      throw new Error("Staging recovery result is inconsistent.");
    }
    record.recoveryRunIds.push(input.currentRunId);
  }

  const validateResults = () => {
    if (
      record.results.netlify &&
      record.results.netlify.publishedDeployId !== targetPair.netlifyDeployId
    ) {
      throw new Error("Restored staging Netlify target differs.");
    }
    if (record.results.worker && record.results.worker.versionId !== targetPair.workerVersionId) {
      throw new Error("Restored staging Worker target differs.");
    }
  };
  validateResults();
  await assertExternalArtifactDirectory(input.repositoryRoot, input.reportDirectory);
  await mkdir(input.reportDirectory, { mode: 0o700 });
  const store = createAtomicJsonStore<StagingRecoveryRecord>(
    resolve(input.reportDirectory, "staging-recovery.json"),
    1024 * 1024,
    () => new Error("Cannot persist staging recovery evidence."),
  );
  const save = () => store.save(stagingRecoveryRecordSchema.parse(record));
  record.outcome = "running";
  delete record.recoveredPair;
  await save();
  let active: RecoveryStep = "inspect";
  const checkpoint: StagingRecoveryCheckpoint = async (value) => {
    record.journal.push({ step: active, value: providerCheckpointSchema.parse(value) });
    await save();
  };
  const inspect = async () => {
    delete record.observedPair;
    record.observedPair = pairSchema.parse(await dependencies.inspect());
    if (!samePair(record.observedPair, expectedStagingRecoveryPair(record)))
      throw new Error("Unexpected live staging pair.");
  };
  try {
    if (
      input.previous?.targetEvidence &&
      input.previous.targetEvidence.inspectionVersion === undefined
    ) {
      if (
        !record.targetEvidence ||
        record.stages["restore-netlify"] !== "passed" ||
        !record.results.netlify ||
        record.stages["restore-worker"] !== "pending" ||
        record.results.worker ||
        record.journal.some(({ step }) => step === "restore-worker")
      ) {
        throw new Error("Legacy staging recovery evidence cannot be migrated safely.");
      }
      active = "inspect";
      await inspect();
      record.targetEvidence = stagingRecoveryTargetEvidenceSchema.parse(
        await dependencies.verifyTargets(),
      );
      if (
        record.targetEvidence.inspectionVersion !== 2 ||
        !samePair(record.targetEvidence.requested, targetPair) ||
        !samePair(record.targetEvidence.expectedCurrent, startingPair)
      ) {
        throw new Error("Migrated staging recovery target evidence differs.");
      }
      await save();
    }
    for (const step of ["restore-netlify", "restore-worker"] as const) {
      if (!["running", "blocked", "failed"].includes(record.stages[step])) continue;
      active = step;
      const result = await dependencies.reconcile(step, record);
      const key = step === "restore-netlify" ? "netlify" : "worker";
      if (Object.keys(result).length !== 1 || !result[key])
        throw new Error("Ambiguous staging recovery result.");
      record.results = { ...record.results, ...result };
      validateResults();
      record.stages[step] = "passed";
      await save();
    }
    active = "inspect";
    record.targetEvidence = stagingRecoveryTargetEvidenceSchema.parse(
      await dependencies.verifyTargets(),
    );
    if (
      !samePair(record.targetEvidence.requested, targetPair) ||
      !samePair(record.targetEvidence.expectedCurrent, startingPair)
    ) {
      throw new Error("Staging recovery target evidence differs.");
    }
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
        record.results.netlify = await dependencies.restoreNetlify(checkpoint);
      } else if (step === "restore-worker") {
        record.results.worker = await dependencies.restoreWorker(checkpoint);
      } else if (step === "verify-transition") {
        if (!(await dependencies.verifyTransition()))
          throw new Error("Staging recovery transition verification failed.");
      } else if (!(await dependencies.verifyPair())) {
        throw new Error("Staging recovery pair verification failed.");
      }
      validateResults();
      record.stages[step] = "passed";
      await save();
      await inspect();
    }
    record.recoveredPair = pairSchema.parse(record.observedPair);
    if (
      record.recoveredPair.netlifyDeployId !== targetPair.netlifyDeployId ||
      record.recoveredPair.workerVersionId !== targetPair.workerVersionId
    )
      throw new Error("Staging recovery target differs.");
    record.outcome = "passed";
    delete record.failure;
  } catch (error) {
    record.outcome = "blocked";
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
