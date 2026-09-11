import { cp, mkdir, rename, rm, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { artifactHash, assertExternalArtifactDirectory } from "./artifact-contract.ts";
import { readReleaseJson } from "./files.ts";
import {
  downloadGitHubArtifact,
  extractVerifiedGitHubArtifact,
  verifyProductionArtifact,
  type GitHubRuntimeEnvironment,
} from "./github-release.ts";
import { prepareRelease, preparedReleaseSchema } from "./prepare.ts";
import { parseProductionArguments } from "./production-args.ts";
import { bindProductionProviderAuthorization } from "./production-authorization.ts";
import {
  productionPreflightSchema,
  verifyLocalProductionEvidence,
  verifyProductionContext,
} from "./production-context.ts";
import { createProductionProviderDependencies } from "./production-providers.ts";
import { runProductionRelease } from "./production-runner.ts";
import { lazyProductionDependencies } from "./production-lazy-providers.ts";
import { verifyProductionWorkspace } from "./production-workspace.ts";
import { approvalSchema, productionRecordSchema } from "./production-record.ts";
import { approvalBytes } from "./production-approval.ts";

export async function runProductionCli(argv: readonly string[], repositoryRoot: string) {
  const phase = argv[0];
  if (phase !== "preflight" && phase !== "execute") throw new Error("Invalid production phase.");
  const args = parseProductionArguments(argv.slice(1), process.cwd());
  if (phase === "preflight") await assertExternalArtifactDirectory(repositoryRoot, args.workspace);
  else await verifyProductionWorkspace(repositoryRoot, args.workspace);
  const token = process.env.GITHUB_TOKEN ?? "";
  const runtime = process.env as GitHubRuntimeEnvironment;
  const artifactDirectory = resolve(args.workspace, "artifacts");
  if (phase === "preflight") {
    const context = await verifyProductionContext(repositoryRoot, args, runtime, token);
    await mkdir(args.workspace, { mode: 0o700 });
    const download = async (
      artifact: { artifactId: number; digest: `sha256:${string}`; sizeInBytes: number },
      directory: string,
    ) => {
      const bytes = await downloadGitHubArtifact({
        token,
        artifactId: artifact.artifactId,
        expectedDigest: artifact.digest,
        expectedSizeInBytes: artifact.sizeInBytes,
      });
      await extractVerifiedGitHubArtifact(bytes, directory);
    };
    await download(context.rehearsal.artifact, resolve(args.workspace, "approval"));
    if (args.resumeRunId !== undefined) {
      const artifact = await verifyProductionArtifact(context.api, {
        runId: args.resumeRunId,
        promotionCommit: context.current.headSha,
      });
      const previousDirectory = resolve(args.workspace, "previous");
      await download(artifact, previousDirectory);
      // Retain only the prior state and sealed bundles, avoiding recursively
      // embedding whole earlier workflow artifacts on every resumed run.
      await cp(
        resolve(previousDirectory, "run/production.json"),
        resolve(args.workspace, "previous-production.json"),
        { errorOnExist: true, force: false },
      );
      await rename(resolve(previousDirectory, "artifacts"), artifactDirectory);
      await rm(previousDirectory, { recursive: true });
    }
    await verifyLocalProductionEvidence(repositoryRoot, args, context);
    const prepared =
      args.resumeRunId === undefined
        ? await prepareRelease({
            repositoryRoot,
            artifactDirectory,
            candidate: context.current.headSha,
            environment: "production",
          })
        : await readReleaseJson(
            resolve(artifactDirectory, "prepared-release.json"),
            preparedReleaseSchema,
          );
    const preflight = productionPreflightSchema.parse({
      schemaVersion: 1,
      operation: "production-preflight",
      runId: context.current.runId,
      promotionPr: args.promotionPr,
      rehearsalRunId: args.rehearsalRunId,
      resumeRunId: args.resumeRunId,
      approvalSha256: args.approvalSha256,
      preparationSha256: artifactHash(JSON.stringify(prepared)),
      promotionCommit: context.current.headSha,
    });
    await writeFile(resolve(args.workspace, "preflight.json"), JSON.stringify(preflight) + "\n", {
      flag: "wx",
      mode: 0o600,
    });
    return { schemaVersion: 1, operation: "production-preflight", outcome: "passed" };
  }
  const preflight = await readReleaseJson(
    resolve(args.workspace, "preflight.json"),
    productionPreflightSchema,
  );
  const prepared = await readReleaseJson(
    resolve(artifactDirectory, "prepared-release.json"),
    preparedReleaseSchema,
  );
  if (
    String(preflight.runId) !== runtime.GITHUB_RUN_ID ||
    preflight.promotionPr !== args.promotionPr ||
    preflight.rehearsalRunId !== args.rehearsalRunId ||
    preflight.resumeRunId !== args.resumeRunId ||
    preflight.approvalSha256 !== args.approvalSha256 ||
    preflight.promotionCommit !== runtime.GITHUB_SHA ||
    preflight.preparationSha256 !== artifactHash(JSON.stringify(prepared))
  )
    throw new Error("Prepared evidence differs from invocation.");
  const approval = await readReleaseJson(
    resolve(args.workspace, "approval/approval.json"),
    approvalSchema,
  );
  const previous =
    args.resumeRunId === undefined
      ? undefined
      : await readReleaseJson(
          resolve(args.workspace, "previous-production.json"),
          productionRecordSchema,
        );
  if (artifactHash(approvalBytes(approval)) !== args.approvalSha256)
    throw new Error("Approval differs from preflight.");
  const dependencies = lazyProductionDependencies(async () => {
    // Persist the runner's initial state before repeating remote checks. A
    // transient GitHub or provider failure must not erase the resume trail.
    const context = await verifyProductionContext(repositoryRoot, args, runtime, token);
    const verified = await verifyLocalProductionEvidence(repositoryRoot, args, context);
    if (
      JSON.stringify(verified.approval) !== JSON.stringify(approval) ||
      JSON.stringify(verified.previous) !== JSON.stringify(previous)
    )
      throw new Error("Approval evidence changed during execution.");
    return createProductionProviderDependencies({
      repositoryRoot,
      artifactDirectory,
      prepared,
      configuration: context.configuration,
      approval,
      smokeOutputDirectory: resolve(args.workspace, "smoke"),
      authorization: bindProductionProviderAuthorization(prepared, context.configuration),
    });
  });
  return runProductionRelease(
    {
      repositoryRoot,
      reportDirectory: resolve(args.workspace, "run"),
      approval,
      prepared,
      promotionCommit: preflight.promotionCommit,
      currentRunId: preflight.runId,
      previous,
    },
    dependencies,
  );
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const result = await runProductionCli(
      process.argv.slice(2),
      fileURLToPath(new URL("../..", import.meta.url)),
    );
    process.stdout.write(JSON.stringify(result) + "\n");
    if (result.outcome !== "passed") process.exitCode = 1;
  } catch {
    process.stderr.write(
      "Production release blocked; inspect retained sanitized workflow evidence.\n",
    );
    process.exitCode = 1;
  }
}
