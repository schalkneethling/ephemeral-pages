import { lstat } from "node:fs/promises";
import { resolve } from "node:path";
import { z } from "zod/v4";

import { artifactHash } from "./artifact-contract.ts";
import { readReleaseJson } from "./files.ts";
import { completedAdoptionVerifier } from "./production-adoption-completion.ts";
import type { ProductionAdoptionArguments } from "./production-adoption-args.ts";
import { productionAdoptionSourceSchema } from "./production-adoption-record.ts";
import { gitReleaseValue, productionPolicySchema } from "./production-approval.ts";
import { completedRecoveryVerifier } from "./recovery-completion.ts";
import { releaseConfigSchema } from "./schema.ts";
import {
  createGitHubReleaseApi,
  inspectPreviousProductionRun,
  verifyCiValidation,
  verifyProductionInvocation,
  verifyPromotionEvidence,
  type GitHubRuntimeEnvironment,
} from "./github-release.ts";
import { verifyStagingDiagnosticsArtifact } from "./staging-recovery-github.ts";

export const productionAdoptionPreflightSchema = z.strictObject({
  schemaVersion: z.literal(1),
  operation: z.literal("production-adoption-preflight"),
  runId: z.number().int().positive(),
  resumeAdoptionRunId: z.number().int().positive().optional(),
  source: productionAdoptionSourceSchema,
  preparationSha256: z.string().regex(/^[a-f0-9]{64}$/u),
});
export type ProductionAdoptionPreflight = z.infer<typeof productionAdoptionPreflightSchema>;

const requireAbsentBaseline = async (repositoryRoot: string): Promise<void> => {
  try {
    await lstat(resolve(repositoryRoot, "docs/release-evidence/production-baseline.json"));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw new Error("Production baseline state could not be verified.");
  }
  throw new Error("Production adoption requires an absent baseline.");
};

export async function verifyProductionAdoptionContext(
  repositoryRoot: string,
  args: ProductionAdoptionArguments,
  runtime: GitHubRuntimeEnvironment,
  token: string,
) {
  const [configuration, policy] = await Promise.all([
    readReleaseJson(
      resolve(repositoryRoot, "scripts/release/environments.json"),
      releaseConfigSchema,
    ),
    readReleaseJson(
      resolve(repositoryRoot, "scripts/release/production-policy.json"),
      productionPolicySchema,
    ),
    requireAbsentBaseline(repositoryRoot),
  ]);
  if (!policy.adoptionEnabled || policy.productionEnabled) {
    throw new Error("Production adoption is not enabled.");
  }
  const api = createGitHubReleaseApi({ token });
  const current = await verifyProductionInvocation(api, runtime);
  if ((await gitReleaseValue(repositoryRoot, ["rev-parse", "HEAD"])) !== current.headSha) {
    throw new Error("Checked-out source differs from workflow.");
  }
  const candidate = await gitReleaseValue(repositoryRoot, [
    "rev-parse",
    "refs/remotes/origin/stage",
  ]);
  const promotion = await verifyPromotionEvidence(api, {
    pullRequestNumber: args.promotionPr,
    candidate,
    promotionCommit: current.headSha,
  });
  const [ci, staging, prior] = await Promise.all([
    verifyCiValidation(api, current.headSha),
    verifyStagingDiagnosticsArtifact(api, { runId: args.rehearsalRunId }),
    inspectPreviousProductionRun(api, {
      current,
      adoption: { resumeAdoptionRunId: args.resumeAdoptionRunId },
      verifyCompletedAdoption: completedAdoptionVerifier(repositoryRoot, token),
      verifyCompletedRecovery: completedRecoveryVerifier(repositoryRoot, token),
    }),
  ]);
  const maximumAgeMs = policy.maximumEvidenceAgeHours * 3_600_000;
  if (
    staging.run.workflowCommit !== candidate ||
    Date.now() - Date.parse(staging.run.createdAt) > maximumAgeMs ||
    Date.parse(staging.run.createdAt) > Date.now()
  ) {
    throw new Error("Staging adoption evidence differs from promotion.");
  }
  return {
    api,
    current,
    promotion,
    ci,
    staging,
    prior,
    configuration,
    configurationSha256: artifactHash(JSON.stringify(configuration)),
  };
}
