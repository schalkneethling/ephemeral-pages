import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { z } from "zod/v4";
import { artifactGitEnvironment, artifactHash, sourceContractSchema } from "./artifact-contract.ts";
import { runCommand } from "./command.ts";
import { serviceChanged } from "./changes.ts";
import { readReleaseJson } from "./files.ts";
import { preparedReleaseSchema } from "./prepare.ts";
import { releaseBaselineSchema, releaseConfigSchema, type ReleaseConfig } from "./schema.ts";
import {
  approvalSchema,
  digestSchema,
  migrationSchema,
  pairSchema,
  type ReleaseApproval,
} from "./production-record.ts";

const successfulStages = [
  "inspect",
  "hold-netlify",
  "upload-worker",
  "activate-worker",
  "observe-worker",
  "verify-transition",
  "prepublish-check",
  "publish-netlify",
  "observe-netlify",
  "verify-pair",
] as const;
export const successfulRehearsalSchema = z.strictObject({
  schemaVersion: z.literal(1),
  operation: z.literal("rehearse"),
  outcome: z.literal("passed"),
  source: sourceContractSchema,
  preparationSha256: digestSchema,
  priorPair: pairSchema,
  observedPair: pairSchema,
  activatedWorker: z.strictObject({
    deploymentId: pairSchema.shape.workerDeploymentId,
    versionId: pairSchema.shape.workerVersionId,
  }),
  publishedNetlify: z.strictObject({ publishedDeployId: pairSchema.shape.netlifyDeployId }),
  stages: z.record(z.enum(successfulStages), z.literal("passed")),
  recovery: z.literal("none"),
});
export const productionPolicySchema = z
  .strictObject({
    schemaVersion: z.literal(1),
    productionEnabled: z.boolean(),
    adoptionEnabled: z.boolean(),
    repository: z.literal("schalkneethling/ephemeral-pages"),
    productionWorkflow: z.literal(".github/workflows/release-production.yml"),
    rehearsalWorkflow: z.literal(".github/workflows/release-rehearsal.yml"),
    maximumEvidenceAgeHours: z.number().int().min(1).max(168),
  })
  .refine((value) => !(value.productionEnabled && value.adoptionEnabled), {
    message: "Production release and adoption cannot be enabled together.",
  });
export const approvalBytes = (approval: ReleaseApproval) =>
  `${JSON.stringify(approvalSchema.parse(approval), null, 2)}\n`;
export async function gitReleaseValue(
  repositoryRoot: string,
  args: readonly string[],
): Promise<string> {
  const result = await runCommand("git", args, {
    cwd: repositoryRoot,
    env: artifactGitEnvironment(),
    inheritEnv: false,
    timeoutMs: 30_000,
  });
  if (result.exitCode !== 0) throw new Error("Release source could not be verified.");
  return args[0] === "diff" ? result.stdout : result.stdout.trim();
}
export async function recomputeAffected(repositoryRoot: string, approval: ReleaseApproval) {
  const changed = async (service: "netlify" | "cloudflare") => {
    const baseline = approval.baseline.providers[service]!;
    const output = await gitReleaseValue(repositoryRoot, [
      "diff",
      "--no-renames",
      "--name-only",
      "-z",
      baseline.sourceCommit!,
      approval.candidate,
      "--",
    ]);
    return serviceChanged(service, output.split("\0").filter(Boolean));
  };
  return { netlify: await changed("netlify"), cloudflare: await changed("cloudflare") };
}
export async function validateApprovalBundle(
  repositoryRoot: string,
  directory: string,
  expectedSha256: string,
  config: ReleaseConfig,
) {
  const approval = await readReleaseJson(resolve(directory, "approval.json"), approvalSchema);
  const raw = await readFile(resolve(directory, "approval.json"));
  if (artifactHash(raw) !== expectedSha256 || raw.toString() !== approvalBytes(approval))
    throw new Error("Approval digest differs.");
  const prepared = await readReleaseJson(
    resolve(directory, "staging-preparation.json"),
    preparedReleaseSchema,
  );
  const rehearsal = await readReleaseJson(
    resolve(directory, "rehearsal.json"),
    successfulRehearsalSchema,
  );
  if (
    prepared.source.environment !== "staging" ||
    rehearsal.source.environment !== "staging" ||
    prepared.source.candidate !== approval.candidate ||
    prepared.source.tree !== approval.tree ||
    JSON.stringify(prepared.source) !== JSON.stringify(rehearsal.source) ||
    artifactHash(JSON.stringify(prepared)) !== rehearsal.preparationSha256 ||
    artifactHash(JSON.stringify(prepared)) !== approval.stagingPreparationSha256 ||
    artifactHash(JSON.stringify(rehearsal)) !== approval.stagingRehearsalSha256 ||
    approval.configurationFingerprint !==
      artifactHash(JSON.stringify(releaseConfigSchema.parse(config))) ||
    rehearsal.observedPair.netlifyDeployId !== rehearsal.publishedNetlify.publishedDeployId ||
    rehearsal.observedPair.workerDeploymentId !== rehearsal.activatedWorker.deploymentId ||
    rehearsal.observedPair.workerVersionId !== rehearsal.activatedWorker.versionId
  )
    throw new Error("Rehearsal evidence differs from approval.");
  const candidateConfig = releaseConfigSchema.parse(
    JSON.parse(
      await gitReleaseValue(repositoryRoot, [
        "show",
        `${approval.candidate}:scripts/release/environments.json`,
      ]),
    ),
  );
  if (JSON.stringify(candidateConfig) !== JSON.stringify(releaseConfigSchema.parse(config)))
    throw new Error("Candidate configuration differs from approval.");
  const stagingTarget = candidateConfig.environments.staging;
  if (!stagingTarget.cloudflare) throw new Error("Missing candidate Worker configuration.");
  const workerConfig = await gitReleaseValue(repositoryRoot, [
    "show",
    `${approval.candidate}:${stagingTarget.cloudflare.wranglerConfigPath}`,
  ]);
  if (
    prepared.source.configurationFingerprint !==
    artifactHash(JSON.stringify({ target: stagingTarget, workerConfig }))
  )
    throw new Error("Prepared configuration differs from candidate.");
  const target = config.environments.production;
  if (
    approval.baseline.providers.netlify!.siteId !== target.netlify?.siteId ||
    approval.baseline.providers.cloudflare!.accountId !== target.cloudflare?.accountId ||
    approval.baseline.providers.cloudflare!.workerName !== target.cloudflare?.workerName
  )
    throw new Error("Production baseline targets differ.");
  const affected = await recomputeAffected(repositoryRoot, approval);
  if (
    affected.netlify !== approval.affected.netlify ||
    affected.cloudflare !== approval.affected.cloudflare
  )
    throw new Error("Affected services differ from approved source.");
  const tree = await gitReleaseValue(repositoryRoot, ["rev-parse", `${approval.candidate}^{tree}`]);
  if (tree !== approval.tree) throw new Error("Candidate tree differs.");
  return { approval, prepared, rehearsal };
}
// Called by the trusted staging workflow after successful rehearsal. The baseline
// is a reviewed repository record from the previous production completion; it is
// not fabricated from a common commit for both services.
export async function writeReleaseApproval(
  repositoryRoot: string,
  evidenceDirectory: string,
  baselinePath: string,
) {
  const config = await readReleaseJson(
    resolve(repositoryRoot, "scripts/release/environments.json"),
    releaseConfigSchema,
  );
  const baseline = await readReleaseJson(baselinePath, releaseBaselineSchema);
  const prepared = await readReleaseJson(
    resolve(evidenceDirectory, "staging-preparation.json"),
    preparedReleaseSchema,
  );
  const rehearsal = await readReleaseJson(
    resolve(evidenceDirectory, "rehearsal.json"),
    successfulRehearsalSchema,
  );
  const value = approvalSchema.parse({
    schemaVersion: 1,
    operation: "release-approval",
    candidate: prepared.source.candidate,
    tree: prepared.source.tree,
    configurationFingerprint: artifactHash(JSON.stringify(config)),
    stagingPreparationSha256: artifactHash(JSON.stringify(prepared)),
    stagingRehearsalSha256: artifactHash(JSON.stringify(rehearsal)),
    baseline,
    affected: { netlify: false, cloudflare: false },
    compatibility: "compatible",
    migration: migrationSchema.parse({
      artifactTag: "v1",
      expectedCurrentTag: "v1",
      change: "none",
    }),
    recoveryOrder: ["netlify", "cloudflare"],
  });
  value.affected = await recomputeAffected(repositoryRoot, value);
  const bytes = approvalBytes(value);
  await writeFile(resolve(evidenceDirectory, "approval.json"), bytes, { flag: "wx", mode: 0o600 });
  await validateApprovalBundle(repositoryRoot, evidenceDirectory, artifactHash(bytes), config);
  return { approvalSha256: artifactHash(bytes), candidate: value.candidate };
}
