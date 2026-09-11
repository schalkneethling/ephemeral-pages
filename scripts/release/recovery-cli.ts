import { cp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { artifactHash, assertExternalArtifactDirectory } from "./artifact-contract.ts";
import { readReleaseJson } from "./files.ts";
import { parseRecoveryArguments } from "./recovery-args.ts";
import {
  createGitHubReleaseApi,
  verifyProductionInvocation,
  verifyRecoveryTargetArtifact,
  downloadGitHubArtifact,
  extractVerifiedGitHubArtifact,
  type GitHubRuntimeEnvironment,
} from "./github-release.ts";
import { verifyRecoveryHistory } from "./recovery-github.ts";
import { gitReleaseValue, productionPolicySchema } from "./production-approval.ts";
import { releaseConfigSchema } from "./schema.ts";
import {
  approvalSchema,
  productionRecordSchema,
  type ProductionRecord,
  type ProductionResults,
} from "./production-record.ts";
import { preparedReleaseSchema } from "./prepare.ts";
import { recoveryRecordSchema, type RecoveryRecord } from "./recovery-record.ts";
import {
  recoveryTargetSchema,
  validateRecoveryArtifact,
  validateRecoveryTarget,
  type RecoveryTarget,
} from "./recovery-target.ts";
import {
  verifyHistoricalProductionSource,
  verifyRecoverySourceRecords,
} from "./recovery-source.ts";
import { createProductionProviderDependencies } from "./production-providers.ts";
import { bindProductionProviderAuthorization } from "./production-authorization.ts";
import { expectedProductionPair } from "./production-runner.ts";
import { runRecovery, type RecoveryDependencies } from "./recovery-runner.ts";
import { createRecoveryProviderDependencies } from "./recovery-providers.ts";
import type { RecoveryProviderPlan } from "./recovery-provider-adapters.ts";
import { workerArtifactManifestSchema } from "./worker-artifacts.ts";
import { verifyProductionWorkspace } from "./production-workspace.ts";

import {
  recoveryPreflightArtifactSchema,
  recoveryPreflightSchema,
  type RecoveryPreflight,
} from "./recovery-preflight.ts";

type ArtifactMetadata = RecoveryPreflight["evidenceArtifact"];

const same = (left: unknown, right: unknown): boolean =>
  JSON.stringify(left) === JSON.stringify(right);

const strictlyIncreasing = (values: readonly number[]): boolean =>
  new Set(values).size === values.length &&
  values.every((value, index) => index === 0 || value > values[index - 1]);

const artifactMetadata = (artifact: {
  artifactId: number;
  digest: string;
  sizeInBytes: number;
  expiresAt: string;
}): ArtifactMetadata =>
  recoveryPreflightArtifactSchema.parse({
    artifactId: artifact.artifactId,
    digest: artifact.digest,
    sizeInBytes: artifact.sizeInBytes,
    expiresAt: artifact.expiresAt,
  });

const recoveryPlanHash = (
  target: RecoveryTarget,
  startingPair: RecoveryPreflight["startingPair"],
  targetArtifact: ArtifactMetadata,
): string => artifactHash(JSON.stringify({ target, startingPair, targetArtifact }));

const validateResumeArchive = (input: {
  args: ReturnType<typeof parseRecoveryArguments>;
  preflight: RecoveryPreflight | undefined;
  previous: RecoveryRecord | undefined;
  source: ProductionRecord;
  target: RecoveryTarget;
}): void => {
  const { args, preflight, previous, source, target } = input;
  if (args.resumeRecoveryRunId === undefined) {
    if (preflight !== undefined || previous !== undefined)
      throw Error("Unexpected recovery resume evidence.");
    return;
  }
  const previousRecoveryRunId = previous?.recoveryRunIds.at(-2);
  if (
    preflight === undefined ||
    previous === undefined ||
    !strictlyIncreasing(previous.recoveryRunIds) ||
    previous.recoveryRunIds.some((runId) => runId <= args.recoverySourceRunId) ||
    previous.recoveryRunIds.at(-1) !== args.resumeRecoveryRunId ||
    previous.sourceProductionRunId !== args.recoverySourceRunId ||
    previous.sourceProductionRecordSha256 !== artifactHash(JSON.stringify(source)) ||
    !["running", "blocked", "failed"].includes(previous.outcome) ||
    !same(previous.targetPair, source.priorPair) ||
    preflight.runId !== args.resumeRecoveryRunId ||
    preflight.sourceRunId !== args.recoverySourceRunId ||
    preflight.resumeRunId !== previousRecoveryRunId ||
    preflight.sourceSha256 !== artifactHash(JSON.stringify(source)) ||
    preflight.targetRunId !== target.workerArtifactRunId ||
    preflight.targetSha256 !== artifactHash(JSON.stringify(target)) ||
    !same(preflight.startingPair, previous.startingPair) ||
    preflight.recoveryPlanSha256 !== previous.recoveryPlanSha256 ||
    preflight.recoveryPlanSha256 !==
      recoveryPlanHash(target, previous.startingPair, preflight.targetArtifact)
  ) {
    throw Error("Recovery resume archive differs.");
  }
};
export async function runRecoveryCli(argv: readonly string[], repositoryRoot: string) {
  const phase = argv[0];
  if (phase !== "preflight" && phase !== "execute") throw Error("Invalid recovery phase.");
  const args = parseRecoveryArguments(argv.slice(1), process.cwd());
  if (phase === "preflight") await assertExternalArtifactDirectory(repositoryRoot, args.workspace);
  else await verifyProductionWorkspace(repositoryRoot, args.workspace);
  const runtime = process.env as GitHubRuntimeEnvironment;
  const token = process.env.GITHUB_TOKEN ?? "";
  const context = async () => {
    const policy = await readReleaseJson(
      resolve(repositoryRoot, "scripts/release/production-policy.json"),
      productionPolicySchema,
    );
    if (!policy.productionEnabled) throw Error("Production rollout is not enabled.");
    const api = createGitHubReleaseApi({ token });
    const current = await verifyProductionInvocation(api, runtime);
    if ((await gitReleaseValue(repositoryRoot, ["rev-parse", "HEAD"])) !== current.headSha)
      throw Error("Recovery checkout differs.");
    const history = await verifyRecoveryHistory(api, {
      current,
      recoverySourceRunId: args.recoverySourceRunId,
      resumeRecoveryRunId: args.resumeRecoveryRunId,
    });
    return { api, current, history };
  };
  const target = await readReleaseJson(
    resolve(repositoryRoot, "docs/release-evidence/recovery-target.json"),
    recoveryTargetSchema,
  );
  const configuration = await readReleaseJson(
    resolve(repositoryRoot, "scripts/release/environments.json"),
    releaseConfigSchema,
  );
  const sourceDirectory = resolve(args.workspace, "source"),
    targetDirectory = resolve(args.workspace, "target");
  const readLocal = async () => {
    const source = await readReleaseJson(
      resolve(sourceDirectory, "run/production.json"),
      productionRecordSchema,
    );
    const approval = await readReleaseJson(
      resolve(sourceDirectory, "approval/approval.json"),
      approvalSchema,
    );
    const prepared = await readReleaseJson(
      resolve(sourceDirectory, "artifacts/prepared-release.json"),
      preparedReleaseSchema,
    );
    const targetRecord = await readReleaseJson(
      resolve(targetDirectory, "run/production.json"),
      productionRecordSchema,
    );
    const targetPrepared = await readReleaseJson(
      resolve(targetDirectory, "artifacts/prepared-release.json"),
      preparedReleaseSchema,
    );
    verifyRecoverySourceRecords(source, approval, prepared, configuration);
    validateRecoveryTarget(target, source, approval);
    validateRecoveryArtifact(target, targetRecord, targetPrepared);
    if (source.runIds.at(-1) !== args.recoverySourceRunId)
      throw Error("Recovery source run differs.");
    const previous =
      args.resumeRecoveryRunId === undefined
        ? undefined
        : await readReleaseJson(
            resolve(args.workspace, "previous-recovery.json"),
            recoveryRecordSchema,
          );
    const previousPreflight =
      args.resumeRecoveryRunId === undefined
        ? undefined
        : await readReleaseJson(
            resolve(args.workspace, "previous-recovery-preflight.json"),
            recoveryPreflightSchema,
          );
    validateResumeArchive({ args, preflight: previousPreflight, previous, source, target });
    return { source, approval, prepared, targetPrepared, previous, previousPreflight };
  };
  if (phase === "preflight") {
    let targetArtifact: ArtifactMetadata;
    const verified = await context();
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
      await extractVerifiedGitHubArtifact(bytes, directory, repositoryRoot);
    };
    if (args.resumeRecoveryRunId === undefined) {
      await download(verified.history.artifact, sourceDirectory);
      const artifact = await verifyRecoveryTargetArtifact(verified.api, {
        runId: target.workerArtifactRunId,
        promotionCommit: target.workerSourceCommit,
      });
      targetArtifact = artifactMetadata(artifact.artifact);
      await download(artifact.artifact, targetDirectory);
    } else {
      const previousDirectory = resolve(args.workspace, "previous");
      await download(verified.history.artifact, previousDirectory);
      const priorPreflight = await readReleaseJson(
        resolve(previousDirectory, "recovery-preflight.json"),
        recoveryPreflightSchema,
      );
      targetArtifact = priorPreflight.targetArtifact;
      await cp(resolve(previousDirectory, "source"), sourceDirectory, {
        recursive: true,
        errorOnExist: true,
        force: false,
      });
      await cp(resolve(previousDirectory, "target"), targetDirectory, {
        recursive: true,
        errorOnExist: true,
        force: false,
      });
      await cp(
        resolve(previousDirectory, "run/recovery.json"),
        resolve(args.workspace, "previous-recovery.json"),
        { errorOnExist: true, force: false },
      );
      await cp(
        resolve(previousDirectory, "recovery-preflight.json"),
        resolve(args.workspace, "previous-recovery-preflight.json"),
        { errorOnExist: true, force: false },
      );
      await rm(previousDirectory, { recursive: true });
    }
    const local = await readLocal();
    if (
      (args.resumeRecoveryRunId === undefined &&
        local.source.promotionCommit !== verified.history.evidenceRun.headSha) ||
      (args.resumeRecoveryRunId !== undefined &&
        local.previousPreflight?.workflowCommit !== verified.history.evidenceRun.headSha)
    )
      throw Error("Recovery source attribution differs.");
    const startingPair =
      local.previous?.startingPair ??
      local.source.observedPair ??
      expectedProductionPair(local.source);
    const record = recoveryPreflightSchema.parse({
      schemaVersion: 1,
      operation: "recovery-preflight",
      evidenceArtifact: artifactMetadata(verified.history.artifact),
      targetArtifact,
      targetRunId: target.workerArtifactRunId,
      runId: verified.current.runId,
      sourceRunId: args.recoverySourceRunId,
      resumeRunId: args.resumeRecoveryRunId,
      workflowCommit: verified.current.headSha,
      sourceSha256: artifactHash(JSON.stringify(local.source)),
      targetSha256: artifactHash(JSON.stringify(target)),
      recoveryPlanSha256: recoveryPlanHash(target, startingPair, targetArtifact),
      startingPair,
    });
    await writeFile(
      resolve(args.workspace, "recovery-target.json"),
      `${JSON.stringify(target)}\n`,
      { flag: "wx", mode: 0o600 },
    );
    await writeFile(
      resolve(args.workspace, "recovery-preflight.json"),
      JSON.stringify(record) + "\n",
      { flag: "wx", mode: 0o600 },
    );
    return { schemaVersion: 1, operation: "recovery-preflight", outcome: "passed" };
  }
  const preflight = await readReleaseJson(
    resolve(args.workspace, "recovery-preflight.json"),
    recoveryPreflightSchema,
  );
  const local = await readLocal();
  const localStartingPair =
    local.previous?.startingPair ??
    local.source.observedPair ??
    expectedProductionPair(local.source);
  if (
    !same(preflight.startingPair, localStartingPair) ||
    preflight.targetRunId !== target.workerArtifactRunId ||
    String(preflight.runId) !== runtime.GITHUB_RUN_ID ||
    preflight.workflowCommit !== runtime.GITHUB_SHA ||
    preflight.sourceRunId !== args.recoverySourceRunId ||
    preflight.resumeRunId !== args.resumeRecoveryRunId ||
    preflight.sourceSha256 !== artifactHash(JSON.stringify(local.source)) ||
    preflight.targetSha256 !== artifactHash(JSON.stringify(target)) ||
    preflight.recoveryPlanSha256 !==
      recoveryPlanHash(target, localStartingPair, preflight.targetArtifact) ||
    (local.previousPreflight !== undefined &&
      !same(preflight.targetArtifact, local.previousPreflight.targetArtifact))
  )
    throw Error("Recovery preflight differs.");
  let dependencies: Promise<RecoveryDependencies> | undefined;
  const initialize = async () => {
    const verified = await context();
    if (
      !same(artifactMetadata(verified.history.artifact), preflight.evidenceArtifact) ||
      (local.previousPreflight !== undefined &&
        local.previousPreflight.workflowCommit !== verified.history.evidenceRun.headSha)
    )
      throw Error("Recovery source artifact changed.");
    if (!local.previous) {
      const targetRun = await verifyRecoveryTargetArtifact(verified.api, {
        runId: target.workerArtifactRunId,
        promotionCommit: target.workerSourceCommit,
      });
      if (!same(artifactMetadata(targetRun.artifact), preflight.targetArtifact))
        throw Error("Recovery target artifact changed.");
    }
    const app = configuration.environments.production.netlify,
      worker = configuration.environments.production.cloudflare;
    if (!app || !worker) throw Error("Explicit recovery targets missing.");
    if (!local.previous) {
      const original = await createProductionProviderDependencies(
        {
          repositoryRoot,
          artifactDirectory: resolve(sourceDirectory, "artifacts"),
          configuration,
          approval: local.approval,
          prepared: local.prepared,
          authorization: bindProductionProviderAuthorization(local.prepared, configuration),
          smokeOutputDirectory: resolve(args.workspace, "source-inspection"),
        },
        {
          verifySource: async (root, candidate) =>
            verifyHistoricalProductionSource(root, candidate, "production", configuration),
        },
      );
      const reconciled = structuredClone(local.source);
      for (const step of [
        "hold-netlify",
        "upload-worker",
        "activate-worker",
        "publish-netlify",
      ] as const) {
        if (["running", "failed", "blocked"].includes(reconciled.stages[step])) {
          const result: ProductionResults = await original.reconcile(step, reconciled);
          reconciled.results = { ...reconciled.results, ...result };
          reconciled.stages[step] = "passed";
        }
      }
      await original.verifyRetained(reconciled);
      if (!same(expectedProductionPair(reconciled), preflight.startingPair))
        throw Error("Source writes do not match recovery start.");
    }
    const artifactDirectory = resolve(
      targetDirectory,
      "artifacts",
      local.targetPrepared.artifacts.worker.directory,
    );
    const manifest = await readReleaseJson(
      resolve(artifactDirectory, "worker-artifact.json"),
      workerArtifactManifestSchema,
    );
    const plan: RecoveryProviderPlan = {
      environment: "production",
      productionSiteId: app.siteId,
      productionWorkerName: worker.workerName,
      requested: target.pair,
      expectedCurrent: preflight.startingPair,
      netlify: {
        ...app,
        origin: app.expectedNonSecretVariables.PUBLIC_BASE_URL,
        targetIdentity: target.netlifyArtifactSha256
          ? {
              kind: "release-artifact",
              candidate: target.netlifySourceCommit,
              artifactSha256: target.netlifyArtifactSha256,
            }
          : { kind: "source-commit", commitRef: target.netlifySourceCommit },
      },
      worker: {
        accountId: worker.accountId,
        workerName: worker.workerName,
        targetArtifactSha256: target.workerArtifactSha256,
        targetScriptEtag: target.workerScriptEtag,
        artifactInput: {
          artifactDirectory,
          environment: "production",
          productionWorkerName: worker.workerName,
          repositoryRoot,
          sourceConfigSha256: artifactHash(
            await readFile(resolve(repositoryRoot, worker.wranglerConfigPath)),
          ),
          target: worker,
        },
        preparedArtifacts: {
          artifactDirectory,
          manifest,
          manifestSha256: target.workerArtifactSha256,
        },
      },
    };
    return createRecoveryProviderDependencies({
      repositoryRoot,
      configuration,
      plan,
      previous: local.previous,
      smokeOutputDirectory: resolve(args.workspace, "smoke"),
    });
  };
  const get = () => (dependencies ??= initialize());
  return runRecovery(
    {
      environment: "production",
      repositoryRoot,
      reportDirectory: resolve(args.workspace, "run"),
      source: local.source,
      sourceProductionRunId: args.recoverySourceRunId,
      recoveryPlanSha256: preflight.recoveryPlanSha256,
      currentRunId: preflight.runId,
      startingPair: preflight.startingPair,
      previous: local.previous,
    },
    {
      inspect: async () => (await get()).inspect(),
      verifyTargets: async () => (await get()).verifyTargets(),
      restoreNetlify: async (checkpoint) => (await get()).restoreNetlify(checkpoint),
      restoreWorker: async (checkpoint) => (await get()).restoreWorker(checkpoint),
      reconcile: async (step, record) => (await get()).reconcile(step, record),
      verifyTransition: async () => (await get()).verifyTransition(),
      verifyPair: async () => (await get()).verifyPair(),
    },
  );
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const record = await runRecoveryCli(
      process.argv.slice(2),
      fileURLToPath(new URL("../..", import.meta.url)),
    );
    process.stdout.write(
      JSON.stringify({ schemaVersion: 1, operation: record.operation, outcome: record.outcome }) +
        "\n",
    );
    if (record.outcome !== "passed") process.exitCode = 1;
  } catch {
    process.stderr.write(
      "Recovery blocked before verified completion. Inspect retained evidence before retrying.\n",
    );
    process.exitCode = 1;
  }
}
