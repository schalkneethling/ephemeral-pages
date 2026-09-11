import { z } from "zod/v4";

import { artifactConfigurationFingerprint, artifactHash } from "./artifact-contract.ts";
import { preparedReleaseSchema } from "./prepare.ts";
import { successfulRehearsalSchema } from "./production-approval.ts";
import { digestSchema, pairSchema, providerIdSchema } from "./production-record.ts";
import { fullCommitSchema, releaseConfigSchema, type ReleaseConfig } from "./schema.ts";

const artifactDigestSchema = z.string().regex(/^sha256:[a-f0-9]{64}$/u);
const workerResultSchema = z.strictObject({
  accountId: providerIdSchema,
  artifactManifestSha256: digestSchema,
  deploymentId: providerIdSchema,
  scriptEtag: z.string().regex(/^[a-f0-9]{32,128}$/u),
  versionId: providerIdSchema,
  workerName: providerIdSchema,
});

export const stagingReleaseEvidenceSchema = z
  .strictObject({
    workflow: z.strictObject({
      artifactDigest: artifactDigestSchema,
      artifactName: z.literal("release-rehearsal-diagnostics"),
      runId: z.number().int().positive(),
      sizeInBytes: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
      workflowCommit: fullCommitSchema,
    }),
    prepared: preparedReleaseSchema,
    rehearsal: successfulRehearsalSchema,
    provider: z.strictObject({
      netlify: z.strictObject({
        artifactSha256: digestSchema,
        deployId: providerIdSchema,
        siteId: providerIdSchema,
      }),
      worker: workerResultSchema,
    }),
  })
  .superRefine((value, context) => {
    const { prepared, provider, rehearsal, workflow } = value;
    if (
      prepared.source.environment !== "staging" ||
      rehearsal.source.environment !== "staging" ||
      workflow.workflowCommit !== prepared.source.candidate ||
      JSON.stringify(prepared.source) !== JSON.stringify(rehearsal.source) ||
      artifactHash(JSON.stringify(prepared)) !== rehearsal.preparationSha256 ||
      prepared.artifacts.netlify.sha256 !== provider.netlify.artifactSha256 ||
      prepared.artifacts.worker.sha256 !== provider.worker.artifactManifestSha256 ||
      rehearsal.publishedNetlify.publishedDeployId !== provider.netlify.deployId ||
      rehearsal.activatedWorker.deploymentId !== provider.worker.deploymentId ||
      rehearsal.activatedWorker.versionId !== provider.worker.versionId ||
      rehearsal.observedPair.netlifyDeployId !== provider.netlify.deployId ||
      rehearsal.observedPair.workerDeploymentId !== provider.worker.deploymentId ||
      rehearsal.observedPair.workerVersionId !== provider.worker.versionId
    ) {
      context.addIssue({ code: "custom", message: "Staging release evidence differs." });
    }
  });
export type StagingReleaseEvidence = z.infer<typeof stagingReleaseEvidenceSchema>;

export const stagingRecoverySourceSchema = z
  .strictObject({
    schemaVersion: z.literal(1),
    operation: z.literal("staging-recovery-source"),
    configurationSha256: digestSchema,
    source: stagingReleaseEvidenceSchema,
    target: stagingReleaseEvidenceSchema,
  })
  .superRefine((value, context) => {
    const sourcePair = value.source.rehearsal.observedPair;
    const targetPair = value.target.rehearsal.observedPair;
    if (
      value.source.workflow.runId <= value.target.workflow.runId ||
      value.source.prepared.source.candidate === value.target.prepared.source.candidate ||
      value.source.prepared.source.configurationFingerprint !==
        value.target.prepared.source.configurationFingerprint ||
      JSON.stringify(value.source.rehearsal.priorPair) !== JSON.stringify(targetPair) ||
      sourcePair.netlifyDeployId === targetPair.netlifyDeployId ||
      sourcePair.workerDeploymentId === targetPair.workerDeploymentId ||
      sourcePair.workerVersionId === targetPair.workerVersionId
    ) {
      context.addIssue({ code: "custom", message: "Staging recovery lineage differs." });
    }
  });
export type StagingRecoverySource = z.infer<typeof stagingRecoverySourceSchema>;

export type ValidatedStagingRecoverySource = {
  sourceRehearsalSha256: string;
  startingPair: z.infer<typeof pairSchema>;
  targetPair: z.infer<typeof pairSchema>;
  targetRehearsalSha256: string;
};

export function validateStagingRecoverySource(
  rawSource: StagingRecoverySource,
  rawConfiguration: ReleaseConfig,
  workerConfig: string,
): ValidatedStagingRecoverySource {
  const source = stagingRecoverySourceSchema.parse(rawSource);
  const configuration = releaseConfigSchema.parse(rawConfiguration);
  if (source.configurationSha256 !== artifactHash(JSON.stringify(configuration))) {
    throw new Error("Staging recovery configuration differs.");
  }
  const staging = configuration.environments.staging;
  const production = configuration.environments.production;
  if (
    !staging.netlify ||
    !staging.cloudflare ||
    !production.netlify ||
    !production.cloudflare ||
    staging.netlify.siteId === production.netlify.siteId ||
    staging.cloudflare.workerName === production.cloudflare.workerName
  ) {
    throw new Error("Distinct staging recovery targets are required.");
  }
  const expectedConfigurationFingerprint = artifactConfigurationFingerprint(staging, workerConfig);
  if (
    source.source.prepared.source.configurationFingerprint !== expectedConfigurationFingerprint ||
    source.target.prepared.source.configurationFingerprint !== expectedConfigurationFingerprint
  ) {
    throw new Error("Staging recovery artifact configuration differs.");
  }
  for (const release of [source.target, source.source]) {
    if (
      release.provider.netlify.siteId !== staging.netlify.siteId ||
      release.provider.worker.accountId !== staging.cloudflare.accountId ||
      release.provider.worker.workerName !== staging.cloudflare.workerName ||
      release.provider.netlify.siteId === production.netlify.siteId ||
      release.provider.worker.workerName === production.cloudflare.workerName
    ) {
      throw new Error("Staging recovery provider targets differ.");
    }
  }
  return {
    sourceRehearsalSha256: artifactHash(JSON.stringify(source.source.rehearsal)),
    startingPair: pairSchema.parse(source.source.rehearsal.observedPair),
    targetPair: pairSchema.parse(source.target.rehearsal.observedPair),
    targetRehearsalSha256: artifactHash(JSON.stringify(source.target.rehearsal)),
  };
}
