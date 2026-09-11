import { z } from "zod/v4";

import { digestSchema, pairSchema } from "./production-record.ts";
import { fullCommitSchema } from "./schema.ts";

const artifactDigestSchema = z.string().regex(/^sha256:[a-f0-9]{64}$/u);
const artifactExpirySchema = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/u)
  .refine((value) => Number.isFinite(Date.parse(value)));

export const recoveryPreflightArtifactSchema = z.strictObject({
  artifactId: z.number().int().positive().safe(),
  digest: artifactDigestSchema,
  sizeInBytes: z.number().int().positive().safe(),
  expiresAt: artifactExpirySchema,
});

export const recoveryPreflightSchema = z.strictObject({
  schemaVersion: z.literal(1),
  operation: z.literal("recovery-preflight"),
  runId: z.number().int().positive().safe(),
  sourceRunId: z.number().int().positive().safe(),
  resumeRunId: z.number().int().positive().safe().optional(),
  workflowCommit: fullCommitSchema,
  sourceSha256: digestSchema,
  targetSha256: digestSchema,
  recoveryPlanSha256: digestSchema,
  startingPair: pairSchema,
  evidenceArtifact: recoveryPreflightArtifactSchema,
  targetArtifact: recoveryPreflightArtifactSchema,
  targetRunId: z.number().int().positive().safe(),
});

export type RecoveryPreflight = z.infer<typeof recoveryPreflightSchema>;
