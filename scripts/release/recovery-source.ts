import { artifactHash } from "./artifact-contract.ts";
import { approvalBytes, gitReleaseValue } from "./production-approval.ts";
import type { PreparedRelease } from "./prepare.ts";
import type { ProductionRecord, ReleaseApproval } from "./production-record.ts";
import { releaseConfigSchema, type ReleaseConfig } from "./schema.ts";

export function verifyRecoverySourceRecords(
  source: ProductionRecord,
  approval: ReleaseApproval,
  prepared: PreparedRelease,
  configuration: ReleaseConfig,
) {
  if (
    source.runIds[0] !== source.originalRunId ||
    source.runIds.some((id, index, ids) => index > 0 && id <= ids[index - 1]) ||
    source.approvalSha256 !== artifactHash(approvalBytes(approval)) ||
    source.preparationSha256 !== artifactHash(JSON.stringify(prepared)) ||
    source.candidate !== approval.candidate ||
    source.tree !== approval.tree ||
    source.tree !== prepared.source.tree ||
    source.promotionCommit !== prepared.source.candidate ||
    prepared.source.environment !== "production" ||
    source.configurationFingerprint !== artifactHash(JSON.stringify(configuration))
  )
    throw new Error("Recovery source evidence differs.");
}
export async function verifyHistoricalProductionSource(
  repositoryRoot: string,
  candidate: string,
  environment: "production",
  expectedConfiguration: ReleaseConfig,
) {
  const configuration = releaseConfigSchema.parse(
    JSON.parse(
      await gitReleaseValue(repositoryRoot, [
        "show",
        `${candidate}:scripts/release/environments.json`,
      ]),
    ),
  );
  if (JSON.stringify(configuration) !== JSON.stringify(expectedConfiguration))
    throw new Error("Recovery configuration has changed.");
  const target = configuration.environments.production;
  if (!target.cloudflare || !target.netlify) throw new Error("Recovery targets missing.");
  const workerConfig = await gitReleaseValue(repositoryRoot, [
    "show",
    `${candidate}:${target.cloudflare.wranglerConfigPath}`,
  ]);
  return {
    configuration,
    source: {
      candidate,
      tree: await gitReleaseValue(repositoryRoot, ["rev-parse", `${candidate}^{tree}`]),
      environment,
      configurationFingerprint: artifactHash(JSON.stringify({ target, workerConfig })),
    },
  };
}
