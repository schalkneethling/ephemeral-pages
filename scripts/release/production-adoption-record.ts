import { z } from "zod/v4";

import {
  digestSchema,
  migrationSchema,
  pairSchema,
  productionResultsSchema,
  providerCheckpointSchema,
  providerIdSchema,
  stageOutcomeSchema,
} from "./production-record.ts";
import { artifactHash } from "./artifact-contract.ts";
import { preparedReleaseSchema, type PreparedRelease } from "./prepare.ts";
import { fullCommitSchema, releaseBaselineSchema } from "./schema.ts";

const timeSchema = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/u)
  .refine((value) => Number.isFinite(Date.parse(value)));

export const productionAdoptionSteps = [
  "inspect",
  "upload-worker",
  "activate-worker",
  "verify-pair",
] as const;
export const productionAdoptionStepSchema = z.enum(productionAdoptionSteps);
export type ProductionAdoptionStep = z.infer<typeof productionAdoptionStepSchema>;

export const productionAdoptionInspectionSchema = z.strictObject({
  pair: pairSchema,
  netlify: z.strictObject({
    siteId: providerIdSchema,
    publishedDeployId: providerIdSchema,
    sourceCommit: fullCommitSchema,
    branch: z.literal("main"),
    context: z.literal("production"),
    publishLocked: z.literal(true),
  }),
  worker: z.strictObject({
    accountId: providerIdSchema,
    workerName: providerIdSchema,
    deploymentId: providerIdSchema,
    versionId: providerIdSchema,
    migrationTag: z.literal("v1"),
    requiredSecretBindingNames: z
      .array(z.string().regex(/^[A-Z][A-Z0-9_]*$/u))
      .max(128)
      .refine((names) => new Set(names).size === names.length),
    secretValuesObservable: z.literal(false),
  }),
});
export type ProductionAdoptionInspection = z.infer<typeof productionAdoptionInspectionSchema>;

export const productionAdoptionSourceSchema = z.strictObject({
  promotionPr: z.number().int().positive(),
  candidate: fullCommitSchema,
  promotionCommit: fullCommitSchema,
  tree: fullCommitSchema,
  configurationSha256: digestSchema,
  productionConfigurationFingerprint: digestSchema,
  staging: z.strictObject({
    runId: z.number().int().positive(),
    workflowCommit: fullCommitSchema,
    artifactId: z.number().int().positive(),
    artifactDigest: z.string().regex(/^sha256:[a-f0-9]{64}$/u),
    artifactSizeInBytes: z.number().int().positive().safe(),
    artifactExpiresAt: timeSchema,
    evidenceSha256: digestSchema,
  }),
});
export type ProductionAdoptionSource = z.infer<typeof productionAdoptionSourceSchema>;

export const productionAdoptionRecordSchema = z
  .strictObject({
    schemaVersion: z.literal(1),
    operation: z.literal("production-adoption"),
    source: productionAdoptionSourceSchema,
    preparationSha256: digestSchema,
    originalRunId: z.number().int().positive(),
    runIds: z.array(z.number().int().positive()).min(1).max(100),
    createdAt: timeSchema,
    updatedAt: timeSchema,
    inspection: productionAdoptionInspectionSchema.optional(),
    migration: migrationSchema,
    stages: z.record(productionAdoptionStepSchema, stageOutcomeSchema),
    results: productionResultsSchema,
    journal: z
      .array(
        z.strictObject({
          step: z.enum(["upload-worker", "activate-worker"]),
          at: timeSchema,
          value: providerCheckpointSchema,
        }),
      )
      .max(10_000),
    observedPair: pairSchema.optional(),
    adoptedPair: pairSchema.optional(),
    proposedBaseline: releaseBaselineSchema.optional(),
    outcome: stageOutcomeSchema,
    failure: z
      .strictObject({
        stage: productionAdoptionStepSchema,
        kind: z.enum(["verification", "ambiguous", "checkpoint", "preflight", "unknown"]),
      })
      .optional(),
    recovery: z.enum(["none", "inspect-recorded-adoption-before-forward-recovery"]),
  })
  .superRefine((record, context) => {
    if (record.results.heldNetlify || record.results.publishedNetlify) {
      context.addIssue({ code: "custom", message: "Adoption cannot mutate Netlify." });
    }
  });
export type ProductionAdoptionRecord = z.infer<typeof productionAdoptionRecordSchema>;

const same = (left: unknown, right: unknown): boolean =>
  JSON.stringify(left) === JSON.stringify(right);

export function validateCompletedAdoption(
  rawRecord: ProductionAdoptionRecord,
  rawPrepared: PreparedRelease,
): ProductionAdoptionRecord {
  const record = productionAdoptionRecordSchema.parse(rawRecord);
  const prepared = preparedReleaseSchema.parse(rawPrepared);
  const inspection = record.inspection;
  const upload = record.results.uploadedWorker;
  const activation = record.results.activatedWorker;
  const expectedPair =
    inspection && activation
      ? {
          netlifyDeployId: inspection.pair.netlifyDeployId,
          workerDeploymentId: activation.deploymentId,
          workerVersionId: activation.versionId,
        }
      : undefined;
  const expectedBaseline =
    inspection && expectedPair
      ? {
          version: 1 as const,
          environment: "production" as const,
          providers: {
            netlify: {
              siteId: inspection.netlify.siteId,
              sourceCommit: inspection.netlify.sourceCommit,
              publishedDeployId: expectedPair.netlifyDeployId,
              publishLocked: true,
            },
            cloudflare: {
              accountId: inspection.worker.accountId,
              workerName: inspection.worker.workerName,
              sourceCommit: record.source.promotionCommit,
              deploymentId: expectedPair.workerDeploymentId,
              traffic: [{ versionId: expectedPair.workerVersionId, percentage: 100 }],
            },
          },
        }
      : undefined;
  if (
    record.outcome !== "passed" ||
    record.failure !== undefined ||
    record.recovery !== "none" ||
    record.runIds[0] !== record.originalRunId ||
    new Set(record.runIds).size !== record.runIds.length ||
    record.runIds.some((runId, index, runIds) => index > 0 && runId <= runIds[index - 1]) ||
    productionAdoptionSteps.some((step) => record.stages[step] !== "passed") ||
    prepared.source.environment !== "production" ||
    prepared.source.candidate !== record.source.promotionCommit ||
    prepared.source.tree !== record.source.tree ||
    prepared.source.configurationFingerprint !== record.source.productionConfigurationFingerprint ||
    artifactHash(JSON.stringify(prepared)) !== record.preparationSha256 ||
    !inspection ||
    !upload ||
    !activation ||
    !record.observedPair ||
    !record.adoptedPair ||
    !record.proposedBaseline ||
    upload.accountId !== inspection.worker.accountId ||
    upload.workerName !== inspection.worker.workerName ||
    upload.baselineDeploymentId !== inspection.pair.workerDeploymentId ||
    upload.artifactManifestSha256 !== prepared.artifacts.worker.sha256 ||
    !same(upload.migrationPolicy, record.migration) ||
    activation.versionId !== upload.versionId ||
    inspection.netlify.publishedDeployId !== inspection.pair.netlifyDeployId ||
    inspection.worker.deploymentId !== inspection.pair.workerDeploymentId ||
    inspection.worker.versionId !== inspection.pair.workerVersionId ||
    !same(record.observedPair, expectedPair) ||
    !same(record.adoptedPair, expectedPair) ||
    !same(record.proposedBaseline, expectedBaseline)
  ) {
    throw new Error("Production adoption completion evidence differs.");
  }
  return record;
}
