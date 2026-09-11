import { z } from "zod/v4";
import {
  digestSchema,
  pairSchema,
  providerCheckpointSchema,
  stageOutcomeSchema,
} from "./production-record.ts";

export const recoverySteps = [
  "inspect",
  "restore-netlify",
  "verify-transition",
  "restore-worker",
  "verify-pair",
] as const;
export const recoveryStepSchema = z.enum(recoverySteps);
export type RecoveryStep = z.infer<typeof recoveryStepSchema>;
export const recoveryTargetEvidenceSchema = z.strictObject({
  inspectionVersion: z.literal(2).optional(),
  inspectionSha256: digestSchema,
  requested: pairSchema,
  expectedCurrent: pairSchema,
  netlifyIdentity: z.enum(["release-artifact", "source-commit"]),
  netlifyVariablesVerified: z.literal(true),
  workerArtifactSha256: digestSchema,
  workerMigrationTag: z.literal("v1"),
  workerScriptEtag: z.string().regex(/^[a-f0-9]{32,128}$/u),
  workerSecretBindingNames: z.array(z.string().regex(/^[A-Z][A-Z0-9_]*$/u)).max(100),
  workerSecretValuesObservable: z.literal(false),
});
export type RecoveryTargetEvidenceRecord = z.infer<typeof recoveryTargetEvidenceSchema>;
export const recoveryRecordSchema = z.strictObject({
  schemaVersion: z.literal(1),
  operation: z.literal("production-recovery"),
  environment: z.literal("production"),
  sourceProductionRunId: z.number().int().positive(),
  sourceProductionRecordSha256: digestSchema,
  recoveryPlanSha256: digestSchema,
  recoveryRunIds: z.array(z.number().int().positive()).min(1).max(100),
  startingPair: pairSchema,
  targetPair: pairSchema,
  targetEvidence: recoveryTargetEvidenceSchema.optional(),
  observedPair: pairSchema.optional(),
  recoveredPair: pairSchema.optional(),
  outcome: stageOutcomeSchema,
  stages: z.record(recoveryStepSchema, stageOutcomeSchema),
  results: z.strictObject({
    netlify: z.strictObject({ publishedDeployId: z.string().min(1).max(256) }).optional(),
    worker: z
      .strictObject({
        deploymentId: z.string().min(1).max(256),
        versionId: z.string().min(1).max(256),
      })
      .optional(),
  }),
  journal: z
    .array(z.strictObject({ step: recoveryStepSchema, value: providerCheckpointSchema }))
    .max(1000),
  failure: z
    .strictObject({
      stage: recoveryStepSchema,
      kind: z.enum(["verification", "ambiguous", "checkpoint", "preflight", "unknown"]),
    })
    .optional(),
});
export type RecoveryRecord = z.infer<typeof recoveryRecordSchema>;
