import { mkdir } from "node:fs/promises";
import { resolve } from "node:path";

import { artifactHash, assertExternalArtifactDirectory } from "./artifact-contract.ts";
import { createAtomicJsonStore } from "./bootstrap-safety.ts";
import { preparedReleaseSchema, type PreparedRelease } from "./prepare.ts";
import {
  productionAdoptionInspectionSchema,
  productionAdoptionRecordSchema,
  productionAdoptionSourceSchema,
  productionAdoptionSteps,
  type ProductionAdoptionInspection,
  type ProductionAdoptionRecord,
  type ProductionAdoptionSource,
  type ProductionAdoptionStep,
} from "./production-adoption-record.ts";
import {
  migrationSchema,
  pairSchema,
  productionResultsSchema,
  providerCheckpointSchema,
  type ProductionResults,
} from "./production-record.ts";

export type ProductionAdoptionMutationStep = "upload-worker" | "activate-worker";
export type ProductionAdoptionCheckpoint = (value: unknown) => Promise<void>;
export type ProductionAdoptionDependencies = {
  inspect(): Promise<ProductionAdoptionInspection>;
  verifyRetained(record: ProductionAdoptionRecord): Promise<void>;
  uploadWorker(
    checkpoint: ProductionAdoptionCheckpoint,
  ): Promise<NonNullable<ProductionResults["uploadedWorker"]>>;
  activateWorker(
    upload: NonNullable<ProductionResults["uploadedWorker"]>,
    checkpoint: ProductionAdoptionCheckpoint,
  ): Promise<NonNullable<ProductionResults["activatedWorker"]>>;
  reconcile(
    step: ProductionAdoptionMutationStep,
    record: ProductionAdoptionRecord,
  ): Promise<ProductionResults>;
  verifyPair(): Promise<boolean>;
};

export type ProductionAdoptionRunInput = {
  repositoryRoot: string;
  reportDirectory: string;
  prepared: PreparedRelease;
  source: ProductionAdoptionSource;
  currentRunId: number;
  previous?: ProductionAdoptionRecord;
};

const migration = migrationSchema.parse({
  artifactTag: "v1",
  expectedCurrentTag: "v1",
  change: "none",
});
const mutations = new Set<ProductionAdoptionStep>(["upload-worker", "activate-worker"]);
const resultKeys = {
  "upload-worker": "uploadedWorker",
  "activate-worker": "activatedWorker",
} as const;

const same = (left: unknown, right: unknown): boolean =>
  JSON.stringify(left) === JSON.stringify(right);

const pairFromInspection = (inspection: ProductionAdoptionInspection) =>
  pairSchema.parse(inspection.pair);

const expectedPair = (record: ProductionAdoptionRecord) => ({
  netlifyDeployId: record.inspection!.pair.netlifyDeployId,
  workerDeploymentId:
    record.results.activatedWorker?.deploymentId ?? record.inspection!.pair.workerDeploymentId,
  workerVersionId:
    record.results.activatedWorker?.versionId ?? record.inspection!.pair.workerVersionId,
});

const validateInspection = (
  inspection: ProductionAdoptionInspection,
  record: ProductionAdoptionRecord,
): void => {
  if (
    inspection.netlify.publishedDeployId !== inspection.pair.netlifyDeployId ||
    inspection.worker.deploymentId !== inspection.pair.workerDeploymentId ||
    inspection.worker.versionId !== inspection.pair.workerVersionId ||
    (record.inspection !== undefined &&
      (!same(inspection.netlify, record.inspection.netlify) ||
        inspection.worker.accountId !== record.inspection.worker.accountId ||
        inspection.worker.workerName !== record.inspection.worker.workerName ||
        inspection.worker.migrationTag !== record.inspection.worker.migrationTag ||
        !same(
          inspection.worker.requiredSecretBindingNames,
          record.inspection.worker.requiredSecretBindingNames,
        ) ||
        inspection.worker.secretValuesObservable !== false ||
        !same(inspection.pair, expectedPair(record))))
  ) {
    throw new Error("Production adoption inspection differs.");
  }
};

export async function runProductionAdoption(
  input: ProductionAdoptionRunInput,
  dependencies: ProductionAdoptionDependencies,
): Promise<ProductionAdoptionRecord> {
  const prepared = preparedReleaseSchema.parse(input.prepared);
  const source = productionAdoptionSourceSchema.parse(input.source);
  const preparationSha256 = artifactHash(JSON.stringify(prepared));
  if (
    prepared.source.environment !== "production" ||
    prepared.source.candidate !== source.promotionCommit ||
    prepared.source.tree !== source.tree ||
    prepared.source.configurationFingerprint !== source.productionConfigurationFingerprint
  ) {
    throw new Error("Production adoption source differs.");
  }
  const now = () => new Date().toISOString();
  let record: ProductionAdoptionRecord;
  if (input.previous) {
    record = productionAdoptionRecordSchema.parse(input.previous);
    if (
      !same(record.source, source) ||
      record.preparationSha256 !== preparationSha256 ||
      record.runIds.includes(input.currentRunId) ||
      record.runIds[0] !== record.originalRunId ||
      new Set(record.runIds).size !== record.runIds.length ||
      record.outcome === "passed" ||
      record.proposedBaseline !== undefined ||
      record.adoptedPair !== undefined
    ) {
      throw new Error("Prior adoption evidence differs.");
    }
    let incomplete = false;
    for (const step of productionAdoptionSteps) {
      const complete = record.stages[step] === "passed";
      if (incomplete && record.stages[step] !== "pending") {
        throw new Error("Out-of-order adoption evidence.");
      }
      if (!complete) incomplete = true;
      if (mutations.has(step)) {
        const key = resultKeys[step as ProductionAdoptionMutationStep];
        if (
          (complete && !record.results[key]) ||
          (record.stages[step] === "pending" && record.results[key])
        ) {
          throw new Error("Incomplete adoption mutation evidence.");
        }
      }
    }
    if (
      (record.stages.inspect === "passed") !== Boolean(record.inspection) ||
      record.results.heldNetlify !== undefined ||
      record.results.publishedNetlify !== undefined ||
      (record.results.activatedWorker !== undefined &&
        record.results.activatedWorker.versionId !== record.results.uploadedWorker?.versionId)
    ) {
      throw new Error("Incomplete adoption evidence.");
    }
    record.runIds.push(input.currentRunId);
  } else {
    record = productionAdoptionRecordSchema.parse({
      schemaVersion: 1,
      operation: "production-adoption",
      source,
      preparationSha256,
      originalRunId: input.currentRunId,
      runIds: [input.currentRunId],
      createdAt: now(),
      updatedAt: now(),
      migration,
      stages: Object.fromEntries(productionAdoptionSteps.map((step) => [step, "pending"])),
      results: {},
      journal: [],
      outcome: "pending",
      recovery: "none",
    });
  }

  await assertExternalArtifactDirectory(input.repositoryRoot, input.reportDirectory);
  await mkdir(input.reportDirectory, { mode: 0o700 });
  const store = createAtomicJsonStore<ProductionAdoptionRecord>(
    resolve(input.reportDirectory, "adoption.json"),
    8 * 1024 * 1024,
    () => new Error("Cannot persist production adoption evidence."),
  );
  const save = async () => {
    record.updatedAt = now();
    await store.save(productionAdoptionRecordSchema.parse(record));
  };
  record.outcome = "running";
  await save();
  let active: ProductionAdoptionStep = "inspect";
  const applyResult = (step: ProductionAdoptionMutationStep, result: ProductionResults) => {
    const parsed = productionResultsSchema.parse(result);
    const key = resultKeys[step];
    if (Object.values(parsed).filter((value) => value !== undefined).length !== 1 || !parsed[key]) {
      throw new Error("Invalid adoption mutation result.");
    }
    record.results = { ...record.results, ...parsed };
  };
  const inspect = async () => {
    const value = productionAdoptionInspectionSchema.parse(await dependencies.inspect());
    validateInspection(value, record);
    record.observedPair = pairFromInspection(value);
    if (!record.inspection) record.inspection = value;
  };
  const checkpoint: ProductionAdoptionCheckpoint = async (value) => {
    record.recovery = "inspect-recorded-adoption-before-forward-recovery";
    record.journal.push({
      step: active as ProductionAdoptionMutationStep,
      at: now(),
      value: providerCheckpointSchema.parse(value),
    });
    await save();
  };
  try {
    if (input.previous) {
      for (const step of productionAdoptionSteps) {
        if (
          !mutations.has(step) ||
          !["running", "failed", "blocked"].includes(record.stages[step])
        ) {
          continue;
        }
        active = step;
        applyResult(
          step as ProductionAdoptionMutationStep,
          await dependencies.reconcile(step as ProductionAdoptionMutationStep, record),
        );
        record.stages[step] = "passed";
        await save();
      }
      await dependencies.verifyRetained(record);
    }
    active = "inspect";
    if (record.stages.inspect !== "passed") {
      record.stages.inspect = "running";
      await save();
      await inspect();
      record.stages.inspect = "passed";
      await save();
    } else {
      await inspect();
      await save();
    }
    for (const step of productionAdoptionSteps.slice(1)) {
      active = step;
      if (record.stages[step] === "passed") continue;
      record.stages[step] = "running";
      if (mutations.has(step)) {
        record.recovery = "inspect-recorded-adoption-before-forward-recovery";
      }
      await save();
      switch (step) {
        case "upload-worker":
          await inspect();
          applyResult(step, { uploadedWorker: await dependencies.uploadWorker(checkpoint) });
          break;
        case "activate-worker":
          if (!record.results.uploadedWorker) throw new Error("Missing uploaded Worker version.");
          await inspect();
          applyResult(step, {
            activatedWorker: await dependencies.activateWorker(
              record.results.uploadedWorker,
              checkpoint,
            ),
          });
          break;
        case "verify-pair":
          await inspect();
          if (!(await dependencies.verifyPair())) throw new Error("Adoption smoke failed.");
          await inspect();
          break;
      }
      record.stages[step] = "passed";
      await save();
    }
    await inspect();
    if (!record.inspection || !record.results.activatedWorker || !record.observedPair) {
      throw new Error("Adoption completion evidence is missing.");
    }
    record.adoptedPair = pairSchema.parse(record.observedPair);
    record.proposedBaseline = {
      version: 1,
      environment: "production",
      providers: {
        netlify: {
          siteId: record.inspection.netlify.siteId,
          sourceCommit: record.inspection.netlify.sourceCommit,
          publishedDeployId: record.adoptedPair.netlifyDeployId,
          publishLocked: true,
        },
        cloudflare: {
          accountId: record.inspection.worker.accountId,
          workerName: record.inspection.worker.workerName,
          sourceCommit: record.source.promotionCommit,
          deploymentId: record.adoptedPair.workerDeploymentId,
          traffic: [{ versionId: record.adoptedPair.workerVersionId, percentage: 100 }],
        },
      },
    };
    record.outcome = "passed";
    record.recovery = "none";
    delete record.failure;
  } catch (error) {
    if (mutations.has(active)) {
      delete record.observedPair;
      try {
        const value = productionAdoptionInspectionSchema.parse(await dependencies.inspect());
        record.observedPair = pairFromInspection(value);
      } catch {
        /* Unknown live state remains absent. */
      }
    }
    record.stages[active] = mutations.has(active) ? "blocked" : "failed";
    record.outcome = record.stages[active];
    const kind =
      typeof error === "object" && error !== null && "kind" in error ? error.kind : "unknown";
    record.failure = {
      stage: active,
      kind:
        typeof kind === "string" &&
        ["verification", "ambiguous", "checkpoint", "preflight"].includes(kind)
          ? (kind as "verification" | "ambiguous" | "checkpoint" | "preflight")
          : "unknown",
    };
  }
  await save();
  return productionAdoptionRecordSchema.parse(record);
}
