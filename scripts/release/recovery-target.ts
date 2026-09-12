import { z } from "zod/v4";
import {
  validateCompletedAdoption,
  type ProductionAdoptionRecord,
} from "./production-adoption-record.ts";
import {
  digestSchema,
  pairSchema,
  productionRecordSchema,
  type ProductionRecord,
  type ReleaseApproval,
} from "./production-record.ts";
import { fullCommitSchema } from "./schema.ts";
import { preparedReleaseSchema, type PreparedRelease } from "./prepare.ts";
import { artifactHash } from "./artifact-contract.ts";

// Reviewed on the protected branch. These are references to independently
// verified workflow artifacts, never a substitute for live provider readback.
export const recoveryTargetSchema = z.strictObject({
  schemaVersion: z.literal(1),
  operation: z.literal("recovery-target"),
  configurationFingerprint: digestSchema,
  pair: pairSchema,
  netlifySourceCommit: fullCommitSchema,
  netlifyArtifactSha256: digestSchema.optional(),
  workerSourceCommit: fullCommitSchema,
  workerArtifactRunId: z.number().int().positive(),
  workerArtifactKind: z.literal("production-adoption").optional(),
  workerArtifactSha256: digestSchema,
  workerScriptEtag: z.string().regex(/^[a-f0-9]{32,128}$/u),
});
export type RecoveryTarget = z.infer<typeof recoveryTargetSchema>;
export function validateRecoveryTarget(
  target: RecoveryTarget,
  source: ProductionRecord,
  approval: ReleaseApproval,
) {
  recoveryTargetSchema.parse(target);
  const netlify = approval.baseline.providers.netlify;
  const worker = approval.baseline.providers.cloudflare;
  if (
    target.configurationFingerprint !== source.configurationFingerprint ||
    source.configurationFingerprint !== approval.configurationFingerprint ||
    target.pair.netlifyDeployId !== source.priorPair.netlifyDeployId ||
    target.pair.workerDeploymentId !== source.priorPair.workerDeploymentId ||
    target.pair.workerVersionId !== source.priorPair.workerVersionId ||
    netlify?.publishedDeployId !== target.pair.netlifyDeployId ||
    netlify.sourceCommit !== target.netlifySourceCommit ||
    worker?.deploymentId !== target.pair.workerDeploymentId ||
    worker.sourceCommit !== target.workerSourceCommit ||
    worker.traffic[0]?.versionId !== target.pair.workerVersionId
  )
    throw new Error("Recovery target differs from the approved prior pair.");
}
export function validateRecoveryArtifact(
  target: RecoveryTarget,
  record: ProductionRecord,
  prepared: PreparedRelease,
) {
  productionRecordSchema.parse(record);
  preparedReleaseSchema.parse(prepared);
  const upload = record.results.uploadedWorker;
  if (
    target.workerArtifactKind !== undefined ||
    (target.netlifyArtifactSha256 !== undefined &&
      (target.netlifyArtifactSha256 !== prepared.artifacts.netlify.sha256 ||
        record.results.publishedNetlify?.publishedDeployId !== target.pair.netlifyDeployId ||
        record.promotionCommit !== target.netlifySourceCommit)) ||
    record.configurationFingerprint !== target.configurationFingerprint ||
    record.outcome !== "passed" ||
    record.runIds.at(-1) !== target.workerArtifactRunId ||
    record.promotionCommit !== target.workerSourceCommit ||
    prepared.source.candidate !== target.workerSourceCommit ||
    prepared.source.environment !== "production" ||
    record.preparationSha256 !== artifactHash(JSON.stringify(prepared)) ||
    record.tree !== prepared.source.tree ||
    !upload ||
    upload.versionId !== target.pair.workerVersionId ||
    record.results.activatedWorker?.versionId !== target.pair.workerVersionId ||
    upload.artifactManifestSha256 !== target.workerArtifactSha256 ||
    prepared.artifacts.worker.sha256 !== target.workerArtifactSha256 ||
    upload.scriptEtag !== target.workerScriptEtag
  )
    throw new Error("Recovery Worker artifact differs from its trusted release.");
}

// Adoption proves only the newly activated Worker. Its retained Netlify deployment
// keeps its independently verified Git source; the adoption build did not publish it.
export function validateAdoptionRecoveryArtifact(
  target: RecoveryTarget,
  record: ProductionAdoptionRecord,
  prepared: PreparedRelease,
) {
  recoveryTargetSchema.parse(target);
  const adopted = validateCompletedAdoption(record, prepared);
  if (
    target.workerArtifactKind !== "production-adoption" ||
    target.netlifyArtifactSha256 !== undefined ||
    target.configurationFingerprint !== adopted.source.configurationSha256 ||
    target.workerArtifactRunId !== adopted.runIds.at(-1) ||
    target.workerSourceCommit !== adopted.source.promotionCommit ||
    target.netlifySourceCommit !== adopted.inspection!.netlify.sourceCommit ||
    target.pair.netlifyDeployId !== adopted.adoptedPair!.netlifyDeployId ||
    target.pair.workerDeploymentId !== adopted.adoptedPair!.workerDeploymentId ||
    target.pair.workerVersionId !== adopted.adoptedPair!.workerVersionId ||
    target.workerArtifactSha256 !== adopted.results.uploadedWorker!.artifactManifestSha256 ||
    target.workerScriptEtag !== adopted.results.uploadedWorker!.scriptEtag
  )
    throw new Error("Recovery Worker artifact differs from its trusted adoption.");
}
