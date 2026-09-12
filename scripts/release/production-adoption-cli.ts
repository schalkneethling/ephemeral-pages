import { cp, mkdir, rename, rm, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  artifactConfigurationFingerprint,
  artifactHash,
  assertExternalArtifactDirectory,
} from "./artifact-contract.ts";
import { readReleaseJson } from "./files.ts";
import {
  downloadGitHubArtifact,
  extractVerifiedGitHubArtifact,
  type GitHubRuntimeEnvironment,
  type VerifiedProductionArtifact,
} from "./github-release.ts";
import { prepareRelease, preparedReleaseSchema } from "./prepare.ts";
import { parseProductionAdoptionArguments } from "./production-adoption-args.ts";
import {
  productionAdoptionPreflightSchema,
  verifyProductionAdoptionContext,
} from "./production-adoption-context.ts";
import {
  productionAdoptionRecordSchema,
  productionAdoptionSourceSchema,
} from "./production-adoption-record.ts";
import { createProductionAdoptionProviderDependencies } from "./production-adoption-providers.ts";
import {
  runProductionAdoption,
  type ProductionAdoptionDependencies,
} from "./production-adoption-runner.ts";
import { gitReleaseValue } from "./production-approval.ts";
import { bindProductionProviderAuthorization } from "./production-authorization.ts";
import { verifyProductionWorkspace } from "./production-workspace.ts";
import { readStagingReleaseEvidence } from "./staging-recovery-cli.ts";
import { stagingReleaseEvidenceSchema } from "./staging-recovery-source.ts";

const downloadArtifact = async (
  token: string,
  artifact: {
    artifactId: number;
    digest: `sha256:${string}`;
    sizeInBytes: number;
  },
  directory: string,
  repositoryRoot: string,
): Promise<void> => {
  const bytes = await downloadGitHubArtifact({
    token,
    artifactId: artifact.artifactId,
    expectedDigest: artifact.digest,
    expectedSizeInBytes: artifact.sizeInBytes,
  });
  await extractVerifiedGitHubArtifact(bytes, directory, repositoryRoot);
};

const lazyDependencies = (
  create: () => Promise<ProductionAdoptionDependencies>,
): ProductionAdoptionDependencies => {
  let pending: Promise<ProductionAdoptionDependencies> | undefined;
  const get = () => (pending ??= create());
  return {
    inspect: async () => (await get()).inspect(),
    verifyRetained: async (record) => (await get()).verifyRetained(record),
    uploadWorker: async (checkpoint) => (await get()).uploadWorker(checkpoint),
    activateWorker: async (upload, checkpoint) => (await get()).activateWorker(upload, checkpoint),
    reconcile: async (step, record) => (await get()).reconcile(step, record),
    verifyPair: async () => (await get()).verifyPair(),
  };
};

export async function runProductionAdoptionCli(argv: readonly string[], repositoryRoot: string) {
  const phase = argv[0];
  if (phase !== "preflight" && phase !== "execute") {
    throw new Error("Invalid production adoption phase.");
  }
  const args = parseProductionAdoptionArguments(argv.slice(1), process.cwd());
  if (phase === "preflight") {
    await assertExternalArtifactDirectory(repositoryRoot, args.workspace);
  } else {
    await verifyProductionWorkspace(repositoryRoot, args.workspace);
  }
  const token = process.env.GITHUB_TOKEN ?? "";
  const runtime = process.env as GitHubRuntimeEnvironment;
  const artifactDirectory = resolve(args.workspace, "artifacts");
  const stagingDirectory = resolve(args.workspace, "staging");
  if (phase === "preflight") {
    const context = await verifyProductionAdoptionContext(repositoryRoot, args, runtime, token);
    await mkdir(args.workspace, { mode: 0o700 });
    await downloadArtifact(token, context.staging.artifact, stagingDirectory, repositoryRoot);
    const stagingEvidence = await readStagingReleaseEvidence(
      stagingDirectory,
      {
        runId: context.staging.run.runId,
        workflowCommit: context.staging.run.workflowCommit,
        artifact: context.staging.artifact,
      },
      context.configuration,
    );
    const stagingTarget = context.configuration.environments.staging;
    if (!stagingTarget.cloudflare) throw new Error("Staging Worker target is missing.");
    const stagingWorkerConfig = await gitReleaseValue(repositoryRoot, [
      "show",
      `${context.promotion.candidate}:${stagingTarget.cloudflare.wranglerConfigPath}`,
    ]);
    if (
      stagingEvidence.prepared.source.tree !== context.promotion.candidateTree ||
      stagingEvidence.prepared.source.configurationFingerprint !==
        artifactConfigurationFingerprint(stagingTarget, stagingWorkerConfig)
    ) {
      throw new Error("Staging adoption evidence differs from source.");
    }
    const stagingEvidenceSha256 = artifactHash(JSON.stringify(stagingEvidence));
    await writeFile(
      resolve(args.workspace, "staging-evidence.json"),
      `${JSON.stringify(stagingEvidence)}\n`,
      { flag: "wx", mode: 0o600 },
    );
    let previous;
    if (args.resumeAdoptionRunId !== undefined) {
      if (
        context.prior.requiredOperation !== "resume-adoption" ||
        context.prior.previous?.runId !== args.resumeAdoptionRunId ||
        context.prior.previous.headSha !== context.current.headSha ||
        !context.prior.artifact
      ) {
        throw new Error("Production adoption resume evidence differs.");
      }
      const previousDirectory = resolve(args.workspace, "previous");
      await downloadArtifact(
        token,
        context.prior.artifact as VerifiedProductionArtifact,
        previousDirectory,
        repositoryRoot,
      );
      await cp(
        resolve(previousDirectory, "run/adoption.json"),
        resolve(args.workspace, "previous-adoption.json"),
        { errorOnExist: true, force: false },
      );
      await rename(resolve(previousDirectory, "artifacts"), artifactDirectory);
      await rm(previousDirectory, { recursive: true });
      previous = await readReleaseJson(
        resolve(args.workspace, "previous-adoption.json"),
        productionAdoptionRecordSchema,
      );
    } else {
      if (context.prior.previous !== null || context.prior.requiredOperation !== "none") {
        throw new Error("Production adoption history is not empty.");
      }
    }
    const prepared = previous
      ? await readReleaseJson(
          resolve(artifactDirectory, "prepared-release.json"),
          preparedReleaseSchema,
        )
      : await prepareRelease({
          repositoryRoot,
          artifactDirectory,
          candidate: context.current.headSha,
          environment: "production",
        });
    const source = productionAdoptionSourceSchema.parse({
      promotionPr: args.promotionPr,
      candidate: context.promotion.candidate,
      promotionCommit: context.current.headSha,
      tree: context.promotion.promotionTree,
      configurationSha256: context.configurationSha256,
      productionConfigurationFingerprint: prepared.source.configurationFingerprint,
      staging: {
        runId: context.staging.run.runId,
        workflowCommit: context.staging.run.workflowCommit,
        artifactId: context.staging.artifact.artifactId,
        artifactDigest: context.staging.artifact.digest,
        artifactSizeInBytes: context.staging.artifact.sizeInBytes,
        artifactExpiresAt: context.staging.artifact.expiresAt,
        evidenceSha256: stagingEvidenceSha256,
      },
    });
    if (previous && JSON.stringify(previous.source) !== JSON.stringify(source)) {
      throw new Error("Production adoption source changed during resume.");
    }
    const preflight = productionAdoptionPreflightSchema.parse({
      schemaVersion: 1,
      operation: "production-adoption-preflight",
      runId: context.current.runId,
      resumeAdoptionRunId: args.resumeAdoptionRunId,
      source,
      preparationSha256: artifactHash(JSON.stringify(prepared)),
    });
    await writeFile(
      resolve(args.workspace, "adoption-preflight.json"),
      `${JSON.stringify(preflight)}\n`,
      { flag: "wx", mode: 0o600 },
    );
    return { schemaVersion: 1, operation: "production-adoption-preflight", outcome: "passed" };
  }

  const [preflight, prepared, stagingEvidence] = await Promise.all([
    readReleaseJson(
      resolve(args.workspace, "adoption-preflight.json"),
      productionAdoptionPreflightSchema,
    ),
    readReleaseJson(resolve(artifactDirectory, "prepared-release.json"), preparedReleaseSchema),
    readReleaseJson(resolve(args.workspace, "staging-evidence.json"), stagingReleaseEvidenceSchema),
  ]);
  const previous =
    args.resumeAdoptionRunId === undefined
      ? undefined
      : await readReleaseJson(
          resolve(args.workspace, "previous-adoption.json"),
          productionAdoptionRecordSchema,
        );
  if (
    String(preflight.runId) !== runtime.GITHUB_RUN_ID ||
    preflight.source.promotionPr !== args.promotionPr ||
    preflight.source.staging.runId !== args.rehearsalRunId ||
    preflight.resumeAdoptionRunId !== args.resumeAdoptionRunId ||
    preflight.source.promotionCommit !== runtime.GITHUB_SHA ||
    preflight.preparationSha256 !== artifactHash(JSON.stringify(prepared)) ||
    preflight.source.staging.evidenceSha256 !== artifactHash(JSON.stringify(stagingEvidence)) ||
    (previous !== undefined && JSON.stringify(previous.source) !== JSON.stringify(preflight.source))
  ) {
    throw new Error("Prepared adoption evidence differs from invocation.");
  }
  const dependencies = lazyDependencies(async () => {
    const context = await verifyProductionAdoptionContext(repositoryRoot, args, runtime, token);
    if (
      context.current.runId !== preflight.runId ||
      context.current.headSha !== preflight.source.promotionCommit ||
      context.promotion.candidate !== preflight.source.candidate ||
      context.promotion.promotionTree !== preflight.source.tree ||
      context.configurationSha256 !== preflight.source.configurationSha256 ||
      context.staging.run.runId !== preflight.source.staging.runId ||
      context.staging.run.workflowCommit !== preflight.source.staging.workflowCommit ||
      context.staging.artifact.artifactId !== preflight.source.staging.artifactId ||
      context.staging.artifact.digest !== preflight.source.staging.artifactDigest ||
      context.staging.artifact.sizeInBytes !== preflight.source.staging.artifactSizeInBytes ||
      context.staging.artifact.expiresAt !== preflight.source.staging.artifactExpiresAt
    ) {
      throw new Error("Production adoption context changed during execution.");
    }
    return createProductionAdoptionProviderDependencies({
      repositoryRoot,
      artifactDirectory,
      prepared,
      configuration: context.configuration,
      authorization: bindProductionProviderAuthorization(prepared, context.configuration),
      previous,
      smokeOutputDirectory: resolve(args.workspace, "smoke"),
    });
  });
  return runProductionAdoption(
    {
      repositoryRoot,
      reportDirectory: resolve(args.workspace, "run"),
      prepared,
      source: preflight.source,
      currentRunId: preflight.runId,
      previous,
    },
    dependencies,
  );
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const result = await runProductionAdoptionCli(
      process.argv.slice(2),
      fileURLToPath(new URL("../..", import.meta.url)),
    );
    process.stdout.write(`${JSON.stringify(result)}\n`);
    if (result.outcome !== "passed") process.exitCode = 1;
  } catch {
    process.stderr.write(
      "Production adoption blocked; inspect retained sanitized workflow evidence.\n",
    );
    process.exitCode = 1;
  }
}
