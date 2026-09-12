import { cp, mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

import { z } from "zod/v4";

import { artifactHash, assertExternalArtifactDirectory } from "./artifact-contract.ts";
import { readBoundedJson } from "./bootstrap-safety.ts";
import { ReleaseUsageError } from "./args.ts";
import { readReleaseJson } from "./files.ts";
import {
  createGitHubReleaseApi,
  downloadGitHubArtifact,
  extractVerifiedGitHubArtifact,
  type GitHubRuntimeEnvironment,
} from "./github-release.ts";
import { preparedReleaseSchema } from "./prepare.ts";
import { gitReleaseValue, successfulRehearsalSchema } from "./production-approval.ts";
import {
  digestSchema,
  migrationSchema,
  pairSchema,
  providerCheckpointSchema,
  providerIdSchema,
} from "./production-record.ts";
import type { RecoveryProviderPlan } from "./recovery-provider-adapters.ts";
import { createStagingRecoveryProviderDependencies } from "./recovery-providers.ts";
import { recoverySteps } from "./recovery-record.ts";
import { releaseConfigSchema, type ReleaseConfig } from "./schema.ts";
import {
  runStagingRecovery,
  stagingRecoveryRecordSchema,
  type StagingRecoveryDependencies,
  type StagingRecoveryRecord,
} from "./staging-recovery-runner.ts";
import {
  stagingRecoverySourceSchema,
  stagingReleaseEvidenceSchema,
  validateStagingRecoverySource,
  type StagingRecoverySource,
  type StagingReleaseEvidence,
} from "./staging-recovery-source.ts";
import {
  verifyStagingDiagnosticsArtifact,
  verifyStagingRecoveryHistory,
  verifyStagingRecoveryInvocation,
  type VerifiedStagingArtifact,
  type VerifiedStagingRecoveryHistory,
} from "./staging-recovery-github.ts";
import { verifyProductionWorkspace } from "./production-workspace.ts";
import { workerArtifactManifestSchema } from "./worker-artifacts.ts";

const activatedWorkerSchema = z.strictObject({
  accountId: providerIdSchema,
  artifactManifestSha256: digestSchema,
  deploymentId: providerIdSchema,
  migrationPolicy: migrationSchema,
  scriptEtag: z.string().regex(/^[a-f0-9]{32,128}$/u),
  status: z.literal("activated"),
  versionId: providerIdSchema,
  workerName: providerIdSchema,
});
const uploadedWorkerSchema = z.strictObject({
  accountId: providerIdSchema,
  artifactManifestSha256: digestSchema,
  baselineDeploymentId: providerIdSchema,
  migrationPolicy: migrationSchema,
  scriptEtag: z.string().regex(/^[a-f0-9]{32,128}$/u),
  status: z.literal("uploaded"),
  versionId: providerIdSchema,
  workerName: providerIdSchema,
});
const heldNetlifySchema = z.strictObject({
  siteId: providerIdSchema,
  baselineDeployId: providerIdSchema,
  candidateDeployId: providerIdSchema,
  candidate: z.string().regex(/^[a-f0-9]{40}$/u),
  artifactSha256: digestSchema,
  context: z.literal("production"),
  state: z.literal("ready"),
  acknowledgedUploads: z.number().int().nonnegative().nullable(),
});
const netlifyPublishCheckpointSchema = z.strictObject({
  operation: z.literal("restoreSiteDeploy"),
  phase: z.literal("pending-mutation"),
  deployId: providerIdSchema,
  artifactSha256: digestSchema,
});
const publishedNetlifySchema = z.strictObject({ publishedDeployId: providerIdSchema });

const artifactSchema = z.strictObject({
  artifactId: z.number().int().positive().safe(),
  digest: z.string().regex(/^sha256:[a-f0-9]{64}$/u),
  sizeInBytes: z.number().int().positive().safe(),
  expiresAt: z.string().refine((value) => Number.isFinite(Date.parse(value))),
});

export const stagingRecoveryPreflightSchema = z
  .strictObject({
    schemaVersion: z.literal(1),
    operation: z.literal("staging-recovery-preflight"),
    runId: z.number().int().positive().safe(),
    workflowCommit: z.string().regex(/^[a-f0-9]{40}$/u),
    sourceRehearsalRunId: z.number().int().positive().safe(),
    targetRehearsalRunId: z.number().int().positive().safe(),
    resumeRecoveryRunId: z.number().int().positive().safe().optional(),
    sourceSha256: digestSchema,
    recoveryPlanSha256: digestSchema,
    startingPair: pairSchema,
    targetPair: pairSchema,
    sourceArtifact: artifactSchema,
    targetArtifact: artifactSchema,
    resumeArtifact: artifactSchema.optional(),
  })
  .superRefine((value, context) => {
    if ((value.resumeRecoveryRunId === undefined) !== (value.resumeArtifact === undefined)) {
      context.addIssue({ code: "custom", message: "Staging recovery resume evidence differs." });
    }
  });
export type StagingRecoveryPreflight = z.infer<typeof stagingRecoveryPreflightSchema>;

export type StagingRecoveryArguments = {
  sourceRehearsalRunId: number;
  targetRehearsalRunId: number;
  resumeRecoveryRunId?: number;
  workspace: string;
};

const positiveId = (value: string | undefined): number => {
  if (!value || !/^[1-9][0-9]*$/u.test(value)) throw new ReleaseUsageError();
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) throw new ReleaseUsageError();
  return parsed;
};

export function parseStagingRecoveryArguments(
  argv: readonly string[],
  cwd: string,
): StagingRecoveryArguments {
  try {
    const { values, positionals, tokens } = parseArgs({
      args: argv,
      strict: true,
      allowPositionals: false,
      tokens: true,
      options: {
        "source-rehearsal-run-id": { type: "string" },
        "target-rehearsal-run-id": { type: "string" },
        "resume-recovery-run-id": { type: "string" },
        workspace: { type: "string" },
      },
    });
    const names = tokens.filter((token) => token.kind === "option").map((token) => token.name);
    if (positionals.length !== 0 || names.length !== new Set(names).size || !values.workspace)
      throw new ReleaseUsageError();
    const sourceRehearsalRunId = positiveId(values["source-rehearsal-run-id"]);
    const targetRehearsalRunId = positiveId(values["target-rehearsal-run-id"]);
    const resumeRecoveryRunId =
      values["resume-recovery-run-id"] === undefined
        ? undefined
        : positiveId(values["resume-recovery-run-id"]);
    if (
      sourceRehearsalRunId === targetRehearsalRunId ||
      (resumeRecoveryRunId !== undefined &&
        resumeRecoveryRunId <= Math.max(sourceRehearsalRunId, targetRehearsalRunId))
    ) {
      throw new ReleaseUsageError();
    }
    return {
      sourceRehearsalRunId,
      targetRehearsalRunId,
      ...(resumeRecoveryRunId === undefined ? {} : { resumeRecoveryRunId }),
      workspace: resolve(cwd, values.workspace),
    };
  } catch {
    throw new ReleaseUsageError();
  }
}

const artifactMetadata = (artifact: VerifiedStagingArtifact) =>
  artifactSchema.parse({
    artifactId: artifact.artifactId,
    digest: artifact.digest,
    sizeInBytes: artifact.sizeInBytes,
    expiresAt: artifact.expiresAt,
  });

const same = (left: unknown, right: unknown): boolean =>
  JSON.stringify(left) === JSON.stringify(right);

const recoveryPlanHash = (input: {
  sourceSha256: string;
  startingPair: StagingRecoveryPreflight["startingPair"];
  targetPair: StagingRecoveryPreflight["targetPair"];
  sourceArtifact: StagingRecoveryPreflight["sourceArtifact"];
  targetArtifact: StagingRecoveryPreflight["targetArtifact"];
}): string => artifactHash(JSON.stringify(input));

const readProviderEvidence = async (reportsDirectory: string) => {
  const names = (await readdir(reportsDirectory)).filter((name) =>
    /^provider-[0-9]{3}\.json$/u.test(name),
  );
  if (names.length < 1 || names.length > 100) throw Error("Staging provider evidence differs.");
  const values = await Promise.all(
    names.map((name) =>
      readBoundedJson(resolve(reportsDirectory, name), 1024 * 1024, () =>
        Error("Staging provider evidence differs."),
      ),
    ),
  );
  const select = <T>(schema: z.ZodType<T>): T[] =>
    values.flatMap((value) => {
      const parsed = schema.safeParse(value);
      return parsed.success ? [parsed.data] : [];
    });
  const held = select(heldNetlifySchema);
  const uploaded = select(uploadedWorkerSchema);
  const activated = select(activatedWorkerSchema);
  const publishCheckpoints = select(netlifyPublishCheckpointSchema);
  const published = select(publishedNetlifySchema);
  const recognized = values.every((value) =>
    [
      heldNetlifySchema,
      uploadedWorkerSchema,
      activatedWorkerSchema,
      netlifyPublishCheckpointSchema,
      publishedNetlifySchema,
      providerCheckpointSchema,
    ].some((schema) => schema.safeParse(value).success),
  );
  if (
    !recognized ||
    held.length !== 1 ||
    uploaded.length !== 1 ||
    activated.length !== 1 ||
    publishCheckpoints.length !== 1 ||
    published.length !== 1
  ) {
    throw Error("Staging provider evidence differs.");
  }
  return {
    activated: activated[0],
    held: held[0],
    publishCheckpoint: publishCheckpoints[0],
    published: published[0],
    uploaded: uploaded[0],
  };
};

export const readStagingReleaseEvidence = async (
  directory: string,
  workflow: { runId: number; workflowCommit: string; artifact: VerifiedStagingArtifact },
  configuration: ReleaseConfig,
): Promise<StagingReleaseEvidence> => {
  const prepared = await readReleaseJson(
    resolve(directory, "artifacts/prepared-release.json"),
    preparedReleaseSchema,
  );
  const rehearsal = await readReleaseJson(
    resolve(directory, "reports/rehearsal.json"),
    successfulRehearsalSchema,
  );
  const provider = await readProviderEvidence(resolve(directory, "reports"));
  const staging = configuration.environments.staging;
  if (!staging.netlify || !staging.cloudflare) throw Error("Staging recovery targets are missing.");
  if (
    provider.held.siteId !== staging.netlify.siteId ||
    provider.held.candidate !== prepared.source.candidate ||
    provider.held.artifactSha256 !== prepared.artifacts.netlify.sha256 ||
    provider.held.candidateDeployId !== rehearsal.publishedNetlify.publishedDeployId ||
    provider.uploaded.accountId !== staging.cloudflare.accountId ||
    provider.uploaded.workerName !== staging.cloudflare.workerName ||
    provider.uploaded.artifactManifestSha256 !== prepared.artifacts.worker.sha256 ||
    provider.uploaded.versionId !== provider.activated.versionId ||
    provider.uploaded.scriptEtag !== provider.activated.scriptEtag ||
    provider.activated.accountId !== staging.cloudflare.accountId ||
    provider.activated.workerName !== staging.cloudflare.workerName ||
    provider.activated.artifactManifestSha256 !== prepared.artifacts.worker.sha256 ||
    provider.activated.deploymentId !== rehearsal.activatedWorker.deploymentId ||
    provider.activated.versionId !== rehearsal.activatedWorker.versionId ||
    provider.publishCheckpoint.deployId !== provider.held.candidateDeployId ||
    provider.publishCheckpoint.artifactSha256 !== provider.held.artifactSha256 ||
    provider.published.publishedDeployId !== provider.held.candidateDeployId
  ) {
    throw Error("Staging provider evidence differs.");
  }
  return stagingReleaseEvidenceSchema.parse({
    workflow: {
      runId: workflow.runId,
      workflowCommit: workflow.workflowCommit,
      artifactName: workflow.artifact.name,
      artifactDigest: workflow.artifact.digest,
      sizeInBytes: workflow.artifact.sizeInBytes,
    },
    prepared,
    rehearsal,
    provider: {
      netlify: {
        siteId: staging.netlify.siteId,
        deployId: rehearsal.publishedNetlify.publishedDeployId,
        artifactSha256: prepared.artifacts.netlify.sha256,
      },
      worker: {
        accountId: provider.activated.accountId,
        artifactManifestSha256: provider.activated.artifactManifestSha256,
        deploymentId: provider.activated.deploymentId,
        scriptEtag: provider.activated.scriptEtag,
        versionId: provider.activated.versionId,
        workerName: provider.activated.workerName,
      },
    },
  });
};

const downloadArtifact = async (
  token: string,
  artifact: VerifiedStagingArtifact,
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

const validateCompletedHistory = async (
  directory: string,
  history: Extract<VerifiedStagingRecoveryHistory, { mode: "fresh" }>["completed"],
): Promise<void> => {
  if (!history) return;
  const record = await readReleaseJson(
    resolve(directory, "run/staging-recovery.json"),
    stagingRecoveryRecordSchema,
  );
  if (
    record.outcome !== "passed" ||
    record.failure !== undefined ||
    record.recoveryRunIds.at(-1) !== history.run.runId ||
    recoverySteps.some((step) => record.stages[step] !== "passed") ||
    !record.observedPair ||
    !record.recoveredPair ||
    !same(record.observedPair, record.recoveredPair) ||
    record.recoveredPair.netlifyDeployId !== record.targetPair.netlifyDeployId ||
    record.recoveredPair.workerVersionId !== record.targetPair.workerVersionId ||
    record.results.netlify?.publishedDeployId !== record.targetPair.netlifyDeployId ||
    !record.results.worker ||
    record.results.worker.versionId !== record.targetPair.workerVersionId ||
    record.results.worker.deploymentId !== record.recoveredPair.workerDeploymentId
  ) {
    throw Error("Completed staging recovery evidence differs.");
  }
};

const validatePrevious = (
  args: StagingRecoveryArguments,
  source: StagingRecoverySource,
  preflight: StagingRecoveryPreflight | undefined,
  previous: StagingRecoveryRecord | undefined,
): void => {
  if (args.resumeRecoveryRunId === undefined) {
    if (preflight || previous) throw Error("Unexpected staging recovery resume evidence.");
    return;
  }
  const ids = previous?.recoveryRunIds ?? [];
  if (
    !preflight ||
    !previous ||
    new Set(ids).size !== ids.length ||
    ids.some((id, index) => index > 0 && id <= ids[index - 1]) ||
    ids.at(-1) !== args.resumeRecoveryRunId ||
    preflight.runId !== args.resumeRecoveryRunId ||
    preflight.resumeRecoveryRunId !== ids.at(-2) ||
    preflight.sourceRehearsalRunId !== args.sourceRehearsalRunId ||
    preflight.targetRehearsalRunId !== args.targetRehearsalRunId ||
    preflight.sourceSha256 !== artifactHash(JSON.stringify(source)) ||
    previous.sourceSha256 !== preflight.sourceSha256 ||
    previous.recoveryPlanSha256 !== preflight.recoveryPlanSha256 ||
    previous.sourceRehearsalRunId !== args.sourceRehearsalRunId ||
    previous.targetRehearsalRunId !== args.targetRehearsalRunId ||
    !["running", "blocked", "failed"].includes(previous.outcome) ||
    !same(previous.startingPair, preflight.startingPair) ||
    !same(previous.targetPair, preflight.targetPair) ||
    preflight.recoveryPlanSha256 !==
      recoveryPlanHash({
        sourceSha256: preflight.sourceSha256,
        startingPair: preflight.startingPair,
        targetPair: preflight.targetPair,
        sourceArtifact: preflight.sourceArtifact,
        targetArtifact: preflight.targetArtifact,
      })
  ) {
    throw Error("Staging recovery resume evidence differs.");
  }
};

const readLocalEvidence = async (
  args: StagingRecoveryArguments,
  configuration: ReleaseConfig,
  workerConfig: string,
) => {
  const source = await readReleaseJson(
    resolve(args.workspace, "staging-recovery-source.json"),
    stagingRecoverySourceSchema,
  );
  const validated = validateStagingRecoverySource(source, configuration, workerConfig);
  if (
    source.source.workflow.runId !== args.sourceRehearsalRunId ||
    source.target.workflow.runId !== args.targetRehearsalRunId
  ) {
    throw Error("Staging recovery source selection differs.");
  }
  const previous =
    args.resumeRecoveryRunId === undefined
      ? undefined
      : await readReleaseJson(
          resolve(args.workspace, "previous-staging-recovery.json"),
          stagingRecoveryRecordSchema,
        );
  const previousPreflight =
    args.resumeRecoveryRunId === undefined
      ? undefined
      : await readReleaseJson(
          resolve(args.workspace, "previous-staging-recovery-preflight.json"),
          stagingRecoveryPreflightSchema,
        );
  validatePrevious(args, source, previousPreflight, previous);
  return { previous, previousPreflight, source, validated };
};

export async function runStagingRecoveryCli(argv: readonly string[], repositoryRoot: string) {
  const phase = argv[0];
  if (phase !== "preflight" && phase !== "execute") throw new ReleaseUsageError();
  const args = parseStagingRecoveryArguments(argv.slice(1), process.cwd());
  if (phase === "preflight") await assertExternalArtifactDirectory(repositoryRoot, args.workspace);
  else await verifyProductionWorkspace(repositoryRoot, args.workspace);
  const configuration = await readReleaseJson(
    resolve(repositoryRoot, "scripts/release/environments.json"),
    releaseConfigSchema,
  );
  const stagingWorker = configuration.environments.staging.cloudflare;
  if (!stagingWorker) throw Error("Staging recovery targets are missing.");
  const workerConfig = await gitReleaseValue(repositoryRoot, [
    "show",
    `HEAD:${stagingWorker.wranglerConfigPath}`,
  ]);
  const token = process.env.GITHUB_TOKEN ?? "";
  const runtime = process.env as GitHubRuntimeEnvironment;
  const context = async () => {
    const api = createGitHubReleaseApi({ token });
    const current = await verifyStagingRecoveryInvocation(api, runtime);
    if ((await gitReleaseValue(repositoryRoot, ["rev-parse", "HEAD"])) !== current.workflowCommit)
      throw Error("Staging recovery checkout differs.");
    const history = await verifyStagingRecoveryHistory(api, {
      current,
      resumeRecoveryRunId: args.resumeRecoveryRunId,
    });
    if ((args.resumeRecoveryRunId === undefined) !== (history.mode === "fresh"))
      throw Error("Staging recovery history differs.");
    return { api, current, history };
  };

  if (phase === "preflight") {
    const verified = await context();
    await mkdir(args.workspace, { mode: 0o700 });
    const sourceDirectory = resolve(args.workspace, "source-release");
    const targetDirectory = resolve(args.workspace, "target-release");
    let source: StagingRecoverySource;
    let sourceArtifact: StagingRecoveryPreflight["sourceArtifact"];
    let targetArtifact: StagingRecoveryPreflight["targetArtifact"];
    if (verified.history.mode === "fresh") {
      if (verified.history.completed) {
        const completedDirectory = resolve(args.workspace, "completed-recovery");
        await downloadArtifact(
          token,
          verified.history.completed.artifact,
          completedDirectory,
          repositoryRoot,
        );
        await validateCompletedHistory(completedDirectory, verified.history.completed);
        await rm(completedDirectory, { recursive: true });
      }
      const [sourceVerified, targetVerified] = await Promise.all([
        verifyStagingDiagnosticsArtifact(verified.api, { runId: args.sourceRehearsalRunId }),
        verifyStagingDiagnosticsArtifact(verified.api, { runId: args.targetRehearsalRunId }),
      ]);
      await Promise.all([
        downloadArtifact(token, sourceVerified.artifact, sourceDirectory, repositoryRoot),
        downloadArtifact(token, targetVerified.artifact, targetDirectory, repositoryRoot),
      ]);
      const [sourceEvidence, targetEvidence] = await Promise.all([
        readStagingReleaseEvidence(
          sourceDirectory,
          {
            runId: sourceVerified.run.runId,
            workflowCommit: sourceVerified.run.workflowCommit,
            artifact: sourceVerified.artifact,
          },
          configuration,
        ),
        readStagingReleaseEvidence(
          targetDirectory,
          {
            runId: targetVerified.run.runId,
            workflowCommit: targetVerified.run.workflowCommit,
            artifact: targetVerified.artifact,
          },
          configuration,
        ),
      ]);
      source = stagingRecoverySourceSchema.parse({
        schemaVersion: 1,
        operation: "staging-recovery-source",
        configurationSha256: artifactHash(JSON.stringify(configuration)),
        source: sourceEvidence,
        target: targetEvidence,
      });
      sourceArtifact = artifactMetadata(sourceVerified.artifact);
      targetArtifact = artifactMetadata(targetVerified.artifact);
      await writeFile(
        resolve(args.workspace, "staging-recovery-source.json"),
        `${JSON.stringify(source)}\n`,
        { flag: "wx", mode: 0o600 },
      );
    } else {
      const previousDirectory = resolve(args.workspace, "previous-recovery");
      await downloadArtifact(token, verified.history.artifact, previousDirectory, repositoryRoot);
      await Promise.all([
        cp(resolve(previousDirectory, "source-release"), sourceDirectory, {
          recursive: true,
          errorOnExist: true,
          force: false,
        }),
        cp(resolve(previousDirectory, "target-release"), targetDirectory, {
          recursive: true,
          errorOnExist: true,
          force: false,
        }),
        cp(
          resolve(previousDirectory, "staging-recovery-source.json"),
          resolve(args.workspace, "staging-recovery-source.json"),
          { errorOnExist: true, force: false },
        ),
        cp(
          resolve(previousDirectory, "staging-recovery-preflight.json"),
          resolve(args.workspace, "previous-staging-recovery-preflight.json"),
          { errorOnExist: true, force: false },
        ),
        cp(
          resolve(previousDirectory, "run/staging-recovery.json"),
          resolve(args.workspace, "previous-staging-recovery.json"),
          { errorOnExist: true, force: false },
        ),
      ]);
      await rm(previousDirectory, { recursive: true });
      const previousPreflight = await readReleaseJson(
        resolve(args.workspace, "previous-staging-recovery-preflight.json"),
        stagingRecoveryPreflightSchema,
      );
      source = await readReleaseJson(
        resolve(args.workspace, "staging-recovery-source.json"),
        stagingRecoverySourceSchema,
      );
      sourceArtifact = previousPreflight.sourceArtifact;
      targetArtifact = previousPreflight.targetArtifact;
    }
    const local = await readLocalEvidence(args, configuration, workerConfig);
    if (!same(source, local.source)) throw Error("Staging recovery source changed.");
    if (
      local.previousPreflight &&
      (verified.history.mode !== "resume" ||
        local.previousPreflight.workflowCommit !== verified.history.run.workflowCommit)
    ) {
      throw Error("Staging recovery resume attribution differs.");
    }
    const sourceSha256 = artifactHash(JSON.stringify(source));
    const recoveryPlanSha256 = recoveryPlanHash({
      sourceSha256,
      startingPair: local.validated.startingPair,
      targetPair: local.validated.targetPair,
      sourceArtifact,
      targetArtifact,
    });
    const preflight = stagingRecoveryPreflightSchema.parse({
      schemaVersion: 1,
      operation: "staging-recovery-preflight",
      runId: verified.current.runId,
      workflowCommit: verified.current.workflowCommit,
      sourceRehearsalRunId: args.sourceRehearsalRunId,
      targetRehearsalRunId: args.targetRehearsalRunId,
      resumeRecoveryRunId: args.resumeRecoveryRunId,
      sourceSha256,
      recoveryPlanSha256,
      startingPair: local.validated.startingPair,
      targetPair: local.validated.targetPair,
      sourceArtifact,
      targetArtifact,
      ...(verified.history.mode === "resume"
        ? { resumeArtifact: artifactMetadata(verified.history.artifact) }
        : {}),
    });
    await writeFile(
      resolve(args.workspace, "staging-recovery-preflight.json"),
      `${JSON.stringify(preflight)}\n`,
      { flag: "wx", mode: 0o600 },
    );
    return {
      schemaVersion: 1,
      operation: "staging-recovery-preflight",
      outcome: "passed",
    } as const;
  }

  const preflight = await readReleaseJson(
    resolve(args.workspace, "staging-recovery-preflight.json"),
    stagingRecoveryPreflightSchema,
  );
  const local = await readLocalEvidence(args, configuration, workerConfig);
  const sourceSha256 = artifactHash(JSON.stringify(local.source));
  if (
    String(preflight.runId) !== runtime.GITHUB_RUN_ID ||
    preflight.workflowCommit !== runtime.GITHUB_SHA ||
    preflight.sourceRehearsalRunId !== args.sourceRehearsalRunId ||
    preflight.targetRehearsalRunId !== args.targetRehearsalRunId ||
    preflight.resumeRecoveryRunId !== args.resumeRecoveryRunId ||
    preflight.sourceSha256 !== sourceSha256 ||
    !same(preflight.startingPair, local.validated.startingPair) ||
    !same(preflight.targetPair, local.validated.targetPair) ||
    preflight.recoveryPlanSha256 !==
      recoveryPlanHash({
        sourceSha256,
        startingPair: local.validated.startingPair,
        targetPair: local.validated.targetPair,
        sourceArtifact: preflight.sourceArtifact,
        targetArtifact: preflight.targetArtifact,
      }) ||
    (local.previousPreflight !== undefined &&
      (!same(preflight.sourceArtifact, local.previousPreflight.sourceArtifact) ||
        !same(preflight.targetArtifact, local.previousPreflight.targetArtifact)))
  ) {
    throw Error("Staging recovery preflight differs.");
  }

  let dependencies: Promise<StagingRecoveryDependencies> | undefined;
  const initialize = async (): Promise<StagingRecoveryDependencies> => {
    const verified = await context();
    if (verified.history.mode === "resume") {
      if (
        !same(preflight.resumeArtifact, artifactMetadata(verified.history.artifact)) ||
        local.previousPreflight?.workflowCommit !== verified.history.run.workflowCommit
      ) {
        throw Error("Staging recovery resume artifact changed.");
      }
    } else {
      const [sourceVerified, targetVerified] = await Promise.all([
        verifyStagingDiagnosticsArtifact(verified.api, { runId: args.sourceRehearsalRunId }),
        verifyStagingDiagnosticsArtifact(verified.api, { runId: args.targetRehearsalRunId }),
      ]);
      if (
        !same(preflight.sourceArtifact, artifactMetadata(sourceVerified.artifact)) ||
        !same(preflight.targetArtifact, artifactMetadata(targetVerified.artifact)) ||
        sourceVerified.run.workflowCommit !== local.source.source.workflow.workflowCommit ||
        targetVerified.run.workflowCommit !== local.source.target.workflow.workflowCommit
      ) {
        throw Error("Staging rehearsal artifacts changed.");
      }
      if (verified.history.completed) {
        const completedDirectory = resolve(args.workspace, "completed-recovery-recheck");
        await downloadArtifact(
          token,
          verified.history.completed.artifact,
          completedDirectory,
          repositoryRoot,
        );
        try {
          await validateCompletedHistory(completedDirectory, verified.history.completed);
        } finally {
          await rm(completedDirectory, { recursive: true, force: true });
        }
      }
    }
    const staging = configuration.environments.staging;
    const production = configuration.environments.production;
    if (!staging.netlify || !staging.cloudflare || !production.netlify || !production.cloudflare)
      throw Error("Staging recovery targets are missing.");
    const target = local.source.target;
    const artifactDirectory = resolve(
      args.workspace,
      "target-release/artifacts",
      target.prepared.artifacts.worker.directory,
    );
    const manifest = await readReleaseJson(
      resolve(artifactDirectory, "worker-artifact.json"),
      workerArtifactManifestSchema,
    );
    const plan: RecoveryProviderPlan & { environment: "staging" } = {
      environment: "staging",
      requested: local.validated.targetPair,
      expectedCurrent: local.validated.startingPair,
      productionSiteId: production.netlify.siteId,
      productionWorkerName: production.cloudflare.workerName,
      netlify: {
        ...staging.netlify,
        origin: staging.netlify.expectedNonSecretVariables.PUBLIC_BASE_URL,
        targetIdentity: {
          kind: "release-artifact",
          candidate: target.prepared.source.candidate,
          artifactSha256: target.provider.netlify.artifactSha256,
        },
      },
      worker: {
        accountId: staging.cloudflare.accountId,
        workerName: staging.cloudflare.workerName,
        targetArtifactSha256: target.provider.worker.artifactManifestSha256,
        targetScriptEtag: target.provider.worker.scriptEtag,
        artifactInput: {
          artifactDirectory,
          environment: "staging",
          productionWorkerName: production.cloudflare.workerName,
          repositoryRoot,
          sourceConfigSha256: artifactHash(
            await readFile(resolve(repositoryRoot, staging.cloudflare.wranglerConfigPath)),
          ),
          target: staging.cloudflare,
        },
        preparedArtifacts: {
          artifactDirectory,
          manifest,
          manifestSha256: target.provider.worker.artifactManifestSha256,
        },
      },
    };
    return createStagingRecoveryProviderDependencies({
      repositoryRoot,
      configuration,
      plan,
      previous: local.previous,
      smokeOutputDirectory: resolve(args.workspace, "smoke"),
    });
  };
  const get = () => (dependencies ??= initialize());
  return runStagingRecovery(
    {
      configuration,
      currentRunId: preflight.runId,
      previous: local.previous,
      recoveryPlanSha256: preflight.recoveryPlanSha256,
      reportDirectory: resolve(args.workspace, "run"),
      repositoryRoot,
      source: local.source,
      workerConfig,
    },
    {
      inspect: async () => (await get()).inspect(),
      reconcile: async (step, record) => (await get()).reconcile(step, record),
      restoreNetlify: async (checkpoint) => (await get()).restoreNetlify(checkpoint),
      restoreWorker: async (checkpoint) => (await get()).restoreWorker(checkpoint),
      verifyPair: async () => (await get()).verifyPair(),
      verifyTargets: async () => (await get()).verifyTargets(),
      verifyTransition: async () => (await get()).verifyTransition(),
    },
  );
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const result = await runStagingRecoveryCli(
      process.argv.slice(2),
      fileURLToPath(new URL("../..", import.meta.url)),
    );
    process.stdout.write(
      `${JSON.stringify({ schemaVersion: 1, operation: result.operation, outcome: result.outcome })}\n`,
    );
    if (result.outcome !== "passed") process.exitCode = 1;
  } catch {
    process.stderr.write("Staging recovery blocked; inspect retained sanitized evidence.\n");
    process.exitCode = 1;
  }
}
