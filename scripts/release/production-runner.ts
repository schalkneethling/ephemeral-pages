import { mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import { createAtomicJsonStore } from "./bootstrap-safety.ts";
import { artifactHash, assertExternalArtifactDirectory } from "./artifact-contract.ts";
import { approvalBytes } from "./production-approval.ts";
import { preparedReleaseSchema, type PreparedRelease } from "./prepare.ts";
import { providerInspectionDiagnosticSchema } from "./providers.ts";
import {
  approvalSchema,
  pairSchema,
  productionRecordSchema,
  productionResultsSchema,
  productionSteps,
  providerCheckpointSchema,
  type ReleaseApproval,
  type ProductionRecord,
  type ProductionResults,
  type ProductionStep,
} from "./production-record.ts";
import type { DeploymentPair } from "./rehearsal.ts";

export type ProductionMutationStep =
  | "hold-netlify"
  | "upload-worker"
  | "activate-worker"
  | "publish-netlify";
export type ProductionCheckpoint = (value: unknown) => Promise<void>;
export type ProductionDependencies = {
  inspect(): Promise<DeploymentPair>;
  verifyRetained(record: ProductionRecord): Promise<void>;
  holdNetlify(
    checkpoint: ProductionCheckpoint,
  ): Promise<NonNullable<ProductionResults["heldNetlify"]>>;
  uploadWorker(
    checkpoint: ProductionCheckpoint,
  ): Promise<NonNullable<ProductionResults["uploadedWorker"]>>;
  activateWorker(
    upload: NonNullable<ProductionResults["uploadedWorker"]>,
    checkpoint: ProductionCheckpoint,
  ): Promise<NonNullable<ProductionResults["activatedWorker"]>>;
  publishNetlify(
    held: NonNullable<ProductionResults["heldNetlify"]>,
    checkpoint: ProductionCheckpoint,
  ): Promise<NonNullable<ProductionResults["publishedNetlify"]>>;
  reconcile(step: ProductionMutationStep, record: ProductionRecord): Promise<ProductionResults>;
  verifyTransition(): Promise<boolean>;
  verifyPair(): Promise<boolean>;
};
export type ProductionRunInput = {
  repositoryRoot: string;
  reportDirectory: string;
  approval: ReleaseApproval;
  prepared: PreparedRelease;
  promotionCommit: string;
  currentRunId: number;
  previous?: ProductionRecord;
};
const mutations = new Set<ProductionStep>([
  "hold-netlify",
  "upload-worker",
  "activate-worker",
  "publish-netlify",
]);
const resultKeys = {
  "hold-netlify": "heldNetlify",
  "upload-worker": "uploadedWorker",
  "activate-worker": "activatedWorker",
  "publish-netlify": "publishedNetlify",
} as const;
const applies = (step: ProductionStep, approval: ReleaseApproval): boolean => {
  if (["hold-netlify", "prepublish-check", "publish-netlify"].includes(step))
    return approval.affected.netlify;
  if (["upload-worker", "activate-worker", "verify-transition"].includes(step))
    return approval.affected.cloudflare;
  if (step === "verify-pair") return approval.affected.netlify || approval.affected.cloudflare;
  return true;
};
export function expectedProductionPair(record: ProductionRecord): DeploymentPair {
  return {
    netlifyDeployId:
      record.results.publishedNetlify?.publishedDeployId ?? record.priorPair.netlifyDeployId,
    workerDeploymentId:
      record.results.activatedWorker?.deploymentId ?? record.priorPair.workerDeploymentId,
    workerVersionId: record.results.activatedWorker?.versionId ?? record.priorPair.workerVersionId,
  };
}
const samePair = (left: DeploymentPair, right: DeploymentPair) =>
  left.netlifyDeployId === right.netlifyDeployId &&
  left.workerDeploymentId === right.workerDeploymentId &&
  left.workerVersionId === right.workerVersionId;

export async function runProductionRelease(
  input: ProductionRunInput,
  dependencies: ProductionDependencies,
): Promise<ProductionRecord> {
  const approval = approvalSchema.parse(input.approval),
    prepared = preparedReleaseSchema.parse(input.prepared);
  const approvalSha256 = artifactHash(approvalBytes(approval)),
    preparationSha256 = artifactHash(JSON.stringify(prepared));
  if (
    prepared.source.environment !== "production" ||
    prepared.source.candidate !== input.promotionCommit ||
    prepared.source.tree !== approval.tree
  )
    throw new Error("Production source differs from approval.");
  const priorPair = pairSchema.parse({
    netlifyDeployId: approval.baseline.providers.netlify!.publishedDeployId,
    workerDeploymentId: approval.baseline.providers.cloudflare!.deploymentId,
    workerVersionId: approval.baseline.providers.cloudflare!.traffic[0].versionId,
  });
  const now = () => new Date().toISOString();
  let record: ProductionRecord;
  if (input.previous) {
    record = productionRecordSchema.parse(input.previous);
    if (
      record.approvalSha256 !== approvalSha256 ||
      record.preparationSha256 !== preparationSha256 ||
      record.promotionCommit !== input.promotionCommit ||
      record.candidate !== approval.candidate ||
      record.tree !== approval.tree ||
      record.configurationFingerprint !== approval.configurationFingerprint ||
      !samePair(record.priorPair, priorPair) ||
      record.runIds.includes(input.currentRunId)
    )
      throw new Error("Prior evidence does not bind this release.");
    for (const step of productionSteps) {
      if ((record.stages[step] === "not-applicable") !== !applies(step, approval))
        throw new Error("Incomplete prior evidence.");
      if (mutations.has(step)) {
        const key = resultKeys[step as ProductionMutationStep];
        if (record.stages[step] === "passed" && !record.results[key])
          throw new Error("Missing mutation result.");
        if (!applies(step, approval) && record.results[key])
          throw new Error("Unexpected retained service mutation.");
      }
    }
    if (
      record.runIds[0] !== record.originalRunId ||
      new Set(record.runIds).size !== record.runIds.length
    )
      throw new Error("Invalid run lineage.");
    const held = record.results.heldNetlify;
    const uploaded = record.results.uploadedWorker;
    if (
      held &&
      (held.candidate !== input.promotionCommit ||
        held.artifactSha256 !== prepared.artifacts.netlify.sha256 ||
        held.siteId !== approval.baseline.providers.netlify!.siteId ||
        held.baselineDeployId !== priorPair.netlifyDeployId)
    )
      throw new Error("Held deployment differs from approval.");
    if (
      uploaded &&
      (uploaded.artifactManifestSha256 !== prepared.artifacts.worker.sha256 ||
        uploaded.accountId !== approval.baseline.providers.cloudflare!.accountId ||
        uploaded.workerName !== approval.baseline.providers.cloudflare!.workerName ||
        uploaded.baselineDeploymentId !== priorPair.workerDeploymentId ||
        JSON.stringify(uploaded.migrationPolicy) !== JSON.stringify(approval.migration))
    )
      throw new Error("Uploaded Worker differs from approval.");
    if (
      record.results.activatedWorker &&
      record.results.activatedWorker.versionId !== uploaded?.versionId
    )
      throw new Error("Activated Worker differs from upload.");
    if (
      record.results.publishedNetlify &&
      record.results.publishedNetlify.publishedDeployId !== held?.candidateDeployId
    )
      throw new Error("Published deployment differs from upload.");
    let incomplete = false;
    for (const step of productionSteps) {
      if (step === "inspect" || !applies(step, approval)) continue;
      const complete = record.stages[step] === "passed";
      if (incomplete && record.stages[step] !== "pending")
        throw new Error("Out-of-order prior evidence.");
      if (!complete) incomplete = true;
    }
    record.runIds.push(input.currentRunId);
  } else {
    record = productionRecordSchema.parse({
      schemaVersion: 1,
      operation: "production-release",
      approvalSha256,
      preparationSha256,
      candidate: approval.candidate,
      promotionCommit: input.promotionCommit,
      tree: approval.tree,
      configurationFingerprint: approval.configurationFingerprint,
      originalRunId: input.currentRunId,
      runIds: [input.currentRunId],
      createdAt: now(),
      updatedAt: now(),
      outcome: "pending",
      priorPair,
      stages: Object.fromEntries(
        productionSteps.map((step) => [
          step,
          applies(step, approval) ? "pending" : "not-applicable",
        ]),
      ),
      results: {},
      journal: [],
      recovery: "none",
    });
  }
  await assertExternalArtifactDirectory(input.repositoryRoot, input.reportDirectory);
  await mkdir(input.reportDirectory, { mode: 0o700 });
  const store = createAtomicJsonStore<ProductionRecord>(
    resolve(input.reportDirectory, "production.json"),
    8 * 1024 * 1024,
    () => new Error("Cannot persist production evidence."),
  );
  const save = async () => {
    record.updatedAt = now();
    await store.save(productionRecordSchema.parse(record));
  };
  record.outcome = "running";
  await save();
  let active: ProductionStep = "inspect";
  const applyResult = (step: ProductionMutationStep, result: ProductionResults) => {
    const parsed = productionResultsSchema.parse(result),
      key = resultKeys[step];
    if (Object.keys(parsed).length !== 1 || !parsed[key])
      throw new Error("Invalid mutation result.");
    record.results = { ...record.results, ...parsed };
  };
  const inspect = async () => {
    delete record.observedPair;
    record.observedPair = pairSchema.parse(await dependencies.inspect());
    if (!samePair(record.observedPair, expectedProductionPair(record)))
      throw new Error("Unexpected live pair.");
  };
  const checkpoint: ProductionCheckpoint = async (value) => {
    record.recovery = "inspect-recorded-targets-before-recovery";
    record.journal.push({ step: active, at: now(), value: providerCheckpointSchema.parse(value) });
    await save();
  };
  try {
    // Reconcile completed writes before comparing the live pair. A pending write
    // with no authoritative match stays blocked; resumption never repeats it.
    if (input.previous)
      for (const step of productionSteps) {
        if (
          !mutations.has(step) ||
          !applies(step, approval) ||
          !["running", "failed", "blocked"].includes(record.stages[step])
        )
          continue;
        active = step;
        applyResult(
          step as ProductionMutationStep,
          await dependencies.reconcile(step as ProductionMutationStep, record),
        );
        record.stages[step] = "passed";
        await save();
      }
    active = "inspect";
    if (input.previous) await dependencies.verifyRetained(record);
    record.stages.inspect = "running";
    await save();
    await inspect();
    record.stages.inspect = "passed";
    await save();
    for (const step of productionSteps.slice(1)) {
      active = step;
      if (record.stages[step] === "passed" || record.stages[step] === "not-applicable") continue;
      record.stages[step] = "running";
      if (mutations.has(step)) record.recovery = "inspect-recorded-targets-before-recovery";
      await save();
      switch (step) {
        case "hold-netlify":
          applyResult(step, { heldNetlify: await dependencies.holdNetlify(checkpoint) });
          break;
        case "upload-worker":
          applyResult(step, { uploadedWorker: await dependencies.uploadWorker(checkpoint) });
          break;
        case "activate-worker": {
          if (!record.results.uploadedWorker) throw new Error("Missing uploaded version.");
          applyResult(step, {
            activatedWorker: await dependencies.activateWorker(
              record.results.uploadedWorker,
              checkpoint,
            ),
          });
          break;
        }
        case "verify-transition":
          await inspect();
          if (!(await dependencies.verifyTransition())) throw new Error("Transition smoke failed.");
          break;
        case "prepublish-check":
          await inspect();
          break;
        case "publish-netlify": {
          if (!record.results.heldNetlify) throw new Error("Missing held deployment.");
          await inspect();
          applyResult(step, {
            publishedNetlify: await dependencies.publishNetlify(
              record.results.heldNetlify,
              checkpoint,
            ),
          });
          break;
        }
        case "verify-pair":
          await inspect();
          if (!(await dependencies.verifyPair())) throw new Error("Pair smoke failed.");
          await inspect();
          break;
      }
      record.stages[step] = "passed";
      await save();
    }
    active = "inspect";
    await inspect();
    record.outcome = "passed";
    record.recovery = "none";
    delete record.failure;
  } catch (error) {
    if (mutations.has(active)) {
      delete record.observedPair;
      try {
        record.observedPair = pairSchema.parse(await dependencies.inspect());
      } catch {
        /* Unknown live state remains absent. */
      }
    }
    record.stages[active] = mutations.has(active) ? "blocked" : "failed";
    record.outcome = record.stages[active];
    const kind =
      typeof error === "object" && error !== null && "kind" in error ? error.kind : "unknown";
    const diagnostic =
      typeof error === "object" && error !== null && "diagnostic" in error
        ? providerInspectionDiagnosticSchema.safeParse(error.diagnostic)
        : undefined;
    record.failure = {
      stage: active,
      kind:
        typeof kind === "string" &&
        ["verification", "ambiguous", "checkpoint", "preflight"].includes(kind)
          ? (kind as "verification" | "ambiguous" | "checkpoint" | "preflight")
          : "unknown",
      ...(diagnostic?.success ? { diagnostic: diagnostic.data } : {}),
    };
  }
  await save();
  return record;
}
