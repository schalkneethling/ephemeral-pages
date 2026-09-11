import { resolve } from "node:path";
import { z } from "zod/v4";
import { artifactHash } from "./artifact-contract.ts";
import { readReleaseJson } from "./files.ts";
import { releaseConfigSchema } from "./schema.ts";
import {
  approvalBytes,
  gitReleaseValue,
  productionPolicySchema,
  validateApprovalBundle,
} from "./production-approval.ts";
import { productionRecordSchema } from "./production-record.ts";
import type { ProductionArguments } from "./production-args.ts";
import {
  createGitHubReleaseApi,
  verifyProductionInvocation,
  verifyPromotionEvidence,
  verifyCiValidation,
  verifyRehearsalEvidence,
  inspectPreviousProductionRun,
  verifyResumeSource,
  type GitHubRuntimeEnvironment,
} from "./github-release.ts";

export const productionPreflightSchema = z.strictObject({
  schemaVersion: z.literal(1),
  operation: z.literal("production-preflight"),
  runId: z.number().int().positive(),
  promotionPr: z.number().int().positive(),
  rehearsalRunId: z.number().int().positive(),
  resumeRunId: z.number().int().positive().optional(),
  approvalSha256: z.string().regex(/^[a-f0-9]{64}$/u),
  preparationSha256: z.string().regex(/^[a-f0-9]{64}$/u),
  promotionCommit: z.string().regex(/^[a-f0-9]{40}$/u),
});

// Credentials are supplied only by the protected workflow step. Provider
// credentials are never accepted as command arguments or release evidence.
export async function verifyProductionContext(
  repositoryRoot: string,
  args: ProductionArguments,
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
  ]);
  if (!policy.productionEnabled) throw new Error("Production rollout is not enabled.");
  const api = createGitHubReleaseApi({ token });
  const current = await verifyProductionInvocation(api, runtime);
  if ((await gitReleaseValue(repositoryRoot, ["rev-parse", "HEAD"])) !== current.headSha)
    throw new Error("Checked-out source differs from workflow.");
  const candidate = await gitReleaseValue(repositoryRoot, [
    "rev-parse",
    "refs/remotes/origin/stage",
  ]);
  const promotion = await verifyPromotionEvidence(api, {
    pullRequestNumber: args.promotionPr,
    candidate,
    promotionCommit: current.headSha,
  });
  const [ci, rehearsal, prior] = await Promise.all([
    verifyCiValidation(api, current.headSha),
    verifyRehearsalEvidence(api, {
      runId: args.rehearsalRunId,
      candidate,
      maximumAgeMs: policy.maximumEvidenceAgeHours * 3_600_000,
    }),
    inspectPreviousProductionRun(api, { current, resumeRunId: args.resumeRunId }),
  ]);
  return { api, current, promotion, ci, rehearsal, prior, configuration };
}

export async function verifyLocalProductionEvidence(
  repositoryRoot: string,
  args: ProductionArguments,
  context: Awaited<ReturnType<typeof verifyProductionContext>>,
) {
  const bundle = await validateApprovalBundle(
    repositoryRoot,
    resolve(args.workspace, "approval"),
    args.approvalSha256,
    context.configuration,
  );
  if (
    bundle.approval.candidate !== context.promotion.candidate ||
    bundle.approval.tree !== context.promotion.promotionTree
  )
    throw new Error("Approved candidate differs from promotion.");
  const previous =
    args.resumeRunId === undefined
      ? undefined
      : await readReleaseJson(
          resolve(args.workspace, "previous-production.json"),
          productionRecordSchema,
        );
  if (previous) {
    await verifyResumeSource(context.api, {
      current: context.current,
      resumeRunId: args.resumeRunId!,
      originalRunId: previous.originalRunId,
      promotionCommit: context.current.headSha,
    });
    if (
      previous.runIds.at(-1) !== args.resumeRunId ||
      previous.approvalSha256 !== artifactHash(approvalBytes(bundle.approval))
    )
      throw new Error("Resume lineage differs from approval.");
  }
  return { ...bundle, previous };
}
