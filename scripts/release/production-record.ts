import { z } from "zod/v4";
import { fullCommitSchema, releaseBaselineSchema } from "./schema.ts";

export const digestSchema = z.string().regex(/^[a-f0-9]{64}$/u);
export const providerIdSchema = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,255}$/u);
const timeSchema = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u)
  .refine((value) => Number.isFinite(Date.parse(value)));
export const pairSchema = z.strictObject({
  netlifyDeployId: providerIdSchema,
  workerDeploymentId: providerIdSchema,
  workerVersionId: providerIdSchema,
});
export const migrationSchema = z.strictObject({
  artifactTag: z.literal("v1"),
  expectedCurrentTag: z.literal("v1"),
  change: z.literal("none"),
});
export const approvalSchema = z
  .strictObject({
    schemaVersion: z.literal(1),
    operation: z.literal("release-approval"),
    candidate: fullCommitSchema,
    tree: fullCommitSchema,
    configurationFingerprint: digestSchema,
    stagingPreparationSha256: digestSchema,
    stagingRehearsalSha256: digestSchema,
    baseline: releaseBaselineSchema,
    affected: z.strictObject({ netlify: z.boolean(), cloudflare: z.boolean() }),
    compatibility: z.literal("compatible"),
    migration: migrationSchema,
    recoveryOrder: z.tuple([z.literal("netlify"), z.literal("cloudflare")]),
  })
  .superRefine((value, context) => {
    const { netlify, cloudflare } = value.baseline.providers;
    if (
      value.baseline.environment !== "production" ||
      !netlify?.sourceCommit ||
      !cloudflare?.sourceCommit ||
      cloudflare.traffic.length !== 1 ||
      cloudflare.traffic[0].percentage !== 100
    ) {
      context.addIssue({
        code: "custom",
        message: "A known-source production baseline pair is required.",
      });
    }
  });
export type ReleaseApproval = z.infer<typeof approvalSchema>;
export const productionSteps = [
  "inspect",
  "hold-netlify",
  "upload-worker",
  "activate-worker",
  "verify-transition",
  "prepublish-check",
  "publish-netlify",
  "verify-pair",
] as const;
export const productionStepSchema = z.enum(productionSteps);
export type ProductionStep = z.infer<typeof productionStepSchema>;
export const stageOutcomeSchema = z.enum([
  "pending",
  "running",
  "passed",
  "failed",
  "blocked",
  "not-applicable",
]);
const heldSchema = z.strictObject({
  siteId: providerIdSchema,
  baselineDeployId: providerIdSchema,
  candidateDeployId: providerIdSchema,
  candidate: fullCommitSchema,
  artifactSha256: digestSchema,
  context: z.literal("production"),
  state: z.literal("ready"),
  acknowledgedUploads: z.number().int().min(0).nullable(),
});
const uploadedSchema = z.strictObject({
  accountId: providerIdSchema,
  artifactManifestSha256: digestSchema,
  baselineDeploymentId: providerIdSchema,
  migrationPolicy: migrationSchema,
  scriptEtag: z.string().regex(/^[a-f0-9]{32,128}$/u),
  status: z.literal("uploaded"),
  versionId: providerIdSchema,
  workerName: providerIdSchema,
});
export const productionResultsSchema = z.strictObject({
  heldNetlify: heldSchema.optional(),
  uploadedWorker: uploadedSchema.optional(),
  activatedWorker: z
    .strictObject({ deploymentId: providerIdSchema, versionId: providerIdSchema })
    .optional(),
  publishedNetlify: z.strictObject({ publishedDeployId: providerIdSchema }).optional(),
});
export type ProductionResults = z.infer<typeof productionResultsSchema>;
// These are the only metadata keys that provider adapters can retain. Payloads,
// arbitrary provider messages and credential-bearing URLs are never journalled.
export const providerCheckpointSchema = z
  .strictObject({
    operation: z
      .enum([
        "lockDeploy",
        "createSiteDeploy",
        "updateSiteDeploy",
        "uploadDeployFile",
        "uploadDeployFunction",
        "restoreSiteDeploy",
      ])
      .optional(),
    phase: providerIdSchema.optional(),
    accountId: providerIdSchema.optional(),
    siteId: providerIdSchema.optional(),
    workerName: providerIdSchema.optional(),
    artifactSha256: digestSchema.optional(),
    artifactManifestSha256: digestSchema.optional(),
    baselineDeploymentId: providerIdSchema.optional(),
    deployId: providerIdSchema.optional(),
    versionId: providerIdSchema.optional(),
    deploymentId: providerIdSchema.optional(),
    publishedDeployId: providerIdSchema.optional(),
    migrationPolicy: migrationSchema.optional(),
  })
  .refine((value) => Boolean(value.operation || value.phase));
export type ProviderCheckpoint = z.infer<typeof providerCheckpointSchema>;
export const productionRecordSchema = z.strictObject({
  schemaVersion: z.literal(1),
  operation: z.literal("production-release"),
  approvalSha256: digestSchema,
  candidate: fullCommitSchema,
  promotionCommit: fullCommitSchema,
  tree: fullCommitSchema,
  configurationFingerprint: digestSchema,
  originalRunId: z.number().int().positive(),
  runIds: z.array(z.number().int().positive()).min(1).max(100),
  preparationSha256: digestSchema,
  createdAt: timeSchema,
  updatedAt: timeSchema,
  outcome: stageOutcomeSchema,
  priorPair: pairSchema,
  observedPair: pairSchema.optional(),
  stages: z.record(productionStepSchema, stageOutcomeSchema),
  results: productionResultsSchema,
  journal: z
    .array(
      z.strictObject({
        step: productionStepSchema,
        at: timeSchema,
        value: providerCheckpointSchema,
      }),
    )
    .max(10_000),
  failure: z
    .strictObject({
      stage: productionStepSchema,
      kind: z.enum(["verification", "ambiguous", "checkpoint", "preflight", "unknown"]),
    })
    .optional(),
  recovery: z.enum(["none", "inspect-recorded-targets-before-recovery"]),
});
export type ProductionRecord = z.infer<typeof productionRecordSchema>;
