import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { parseArgs } from "node:util";
import {
  artifactBuildEnvironment,
  artifactGitEnvironment,
  artifactHash,
  verifyArtifactSource,
} from "./artifact-contract.ts";
import { createAtomicJsonStore, readBoundedJson } from "./bootstrap-safety.ts";
import { withRehearsalGuard } from "./rehearsal-guard.ts";
import { runCommand, SafeCommandError } from "./command.ts";
import { readReleaseJson } from "./files.ts";
import { verifyNetlifyArtifacts, type NetlifyArtifactInventory } from "./netlify-artifacts.ts";
import {
  createAuthenticatedNetlifyDeploymentClient,
  uploadHeldNetlifyDeployment,
  publishHeldNetlifyDeployment,
  type HeldNetlifyDeployment,
} from "./netlify-deployment.ts";
import { preparedReleaseSchema } from "./prepare.ts";
import {
  inspectCloudflare,
  inspectNetlify,
  ProviderInspectionError,
  type ProviderCommandRunner,
  type ProviderInspectionDiagnostic,
} from "./providers.ts";
import { rehearsePreparedRelease, type DeploymentPair } from "./rehearsal.ts";
import { releaseConfigSchema, type ReleaseConfig } from "./schema.ts";
import { runCollaborationSmoke } from "./smoke.ts";
import { verifyWorkerArtifacts, type WorkerArtifactManifest } from "./worker-artifacts.ts";
import {
  uploadPreparedStagingWorker,
  activatePreparedStagingWorker,
  createWranglerAccessTokenResolver,
  createCloudflareWorkerFetchTransport,
  type UploadedStagingWorkerVersion,
} from "./worker-release.ts";

const NETLIFY_INSPECTION_EXECUTABLE = "./node_modules/.bin/netlify";
const CLOUDFLARE_INSPECTION_EXECUTABLE = "./node_modules/.bin/wrangler";

class RehearsalInspectionError extends Error {
  readonly kind = "failed";

  constructor() {
    super("Provider inspection failed.");
    this.name = "RehearsalInspectionError";
  }
}

class RehearsalObservationCheckpointError extends Error {
  readonly kind = "checkpoint";

  constructor(cause: unknown) {
    super(
      "Cannot persist postpublication observation evidence.",
      cause instanceof Error ? { cause } : undefined,
    );
    this.name = "RehearsalObservationCheckpointError";
  }
}

export function rehearsalInspectionCommandFailure(
  executable: string,
  argv: readonly string[],
  exitCode: number | null,
): ProviderInspectionError {
  const netlify = executable === NETLIFY_INSPECTION_EXECUTABLE;
  const cloudflare = executable === CLOUDFLARE_INSPECTION_EXECUTABLE;
  const operation = netlify
    ? argv[0] === "api" && argv[1] === "getSite"
      ? "getSite"
      : argv[0] === "api" && argv[1] === "getSiteDeploy"
        ? "getSiteDeploy"
        : argv[0] === "api" && argv[1] === "getEnvVars"
          ? "getEnvVars"
          : undefined
    : cloudflare
      ? argv[0] === "deployments" && argv[1] === "status"
        ? "deploymentsStatus"
        : argv[0] === "versions" && argv[1] === "view"
          ? "versionView"
          : argv[0] === "secret" && argv[1] === "list"
            ? "secretList"
            : undefined
      : undefined;
  if (
    !operation ||
    (exitCode !== null && (!Number.isInteger(exitCode) || exitCode < 0 || exitCode > 255))
  ) {
    throw new RehearsalInspectionError();
  }
  return new ProviderInspectionError(
    {
      provider: netlify ? "netlify" : "cloudflare",
      operation,
      classification: "command",
      commandKind: "failed",
      exitCode,
    },
    new SafeCommandError("failed"),
  );
}

export function rehearsalInspectionEnvironment(
  executable: string,
  websocketUrl: string,
  extra: Readonly<Record<string, string>> = {},
): Record<string, string> {
  const names = Object.keys(extra);
  const netlify = executable === NETLIFY_INSPECTION_EXECUTABLE;
  const cloudflare = executable === CLOUDFLARE_INSPECTION_EXECUTABLE;
  if (
    (!netlify && !cloudflare) ||
    (netlify && names.length !== 0) ||
    (cloudflare &&
      (names.some((name) => name !== "CLOUDFLARE_ACCOUNT_ID") ||
        typeof extra.CLOUDFLARE_ACCOUNT_ID !== "string" ||
        extra.CLOUDFLARE_ACCOUNT_ID.length === 0))
  ) {
    throw new RehearsalInspectionError();
  }
  const credentialName = netlify ? "NETLIFY_AUTH_TOKEN" : "CLOUDFLARE_API_TOKEN";
  const credential = process.env[credentialName];
  return {
    ...extra,
    ...artifactBuildEnvironment(websocketUrl),
    ...(credential ? { [credentialName]: credential } : {}),
  };
}

export async function inspectStagingDeploymentPair(
  repositoryRoot: string,
  providedConfiguration?: ReleaseConfig,
  options: { deadlineAt?: number; now?: () => number } = {},
): Promise<DeploymentPair> {
  const now = options.now ?? (() => performance.now());
  const configuration = providedConfiguration
    ? releaseConfigSchema.parse(providedConfiguration)
    : await readReleaseJson(
        resolve(repositoryRoot, "scripts/release/environments.json"),
        releaseConfigSchema,
      );
  const appTarget = configuration.environments.staging.netlify;
  const workerTarget = configuration.environments.staging.cloudflare;
  const production = configuration.environments.production;
  if (
    !appTarget ||
    !workerTarget ||
    !production.netlify ||
    !production.cloudflare ||
    appTarget.siteId === production.netlify.siteId ||
    workerTarget.workerName === production.cloudflare.workerName
  ) {
    throw new ProviderInspectionError({
      provider: "pair",
      operation: "expectedPair",
      classification: "assertion",
      assertion: "provider-policy",
    });
  }
  const run: ProviderCommandRunner = async (executable, argv, extra) => {
    const remaining = (options.deadlineAt ?? Number.POSITIVE_INFINITY) - now();
    if (remaining <= 0) throw new SafeCommandError("timeout");
    const result = await runCommand(executable, argv, {
      cwd: repositoryRoot,
      inheritEnv: false,
      env: rehearsalInspectionEnvironment(
        executable,
        appTarget.expectedNonSecretVariables.COLLABORATION_WEBSOCKET_URL,
        extra,
      ),
      timeoutMs: Math.min(60_000, Math.max(1, Math.floor(remaining))),
    });
    if (result.exitCode !== 0) {
      throw rehearsalInspectionCommandFailure(executable, argv, result.exitCode);
    }
    return result.stdout;
  };
  const [appResult, workerResult] = await Promise.allSettled([
    inspectNetlify(appTarget, run),
    inspectCloudflare(
      {
        ...workerTarget,
        wranglerConfigPath: resolve(repositoryRoot, workerTarget.wranglerConfigPath),
      },
      run,
    ),
  ]);
  if (appResult.status === "rejected") throw appResult.reason;
  if (workerResult.status === "rejected") throw workerResult.reason;
  const app = appResult.value;
  const workerState = workerResult.value;
  if (
    !app.variableScopesMatch ||
    Object.values(app.nonSecretVariables).some(
      (value) => !value.present || !value.matchesExpected,
    ) ||
    Object.values(app.requiredSecrets).some((value) => !value)
  ) {
    throw new ProviderInspectionError({
      provider: "netlify",
      operation: "getEnvVars",
      classification: "assertion",
      assertion: "provider-policy",
    });
  }
  if (
    Object.values(workerState.nonSecretVariables).some(
      (value) => !value.present || !value.matchesExpected,
    ) ||
    Object.values(workerState.requiredSecrets).some((value) => !value) ||
    workerState.traffic.length !== 1 ||
    workerState.traffic[0].percentage !== 100
  ) {
    throw new ProviderInspectionError({
      provider: "cloudflare",
      operation: "deploymentsStatus",
      classification: "assertion",
      assertion: "provider-policy",
    });
  }
  return {
    netlifyDeployId: app.publishedDeployId,
    workerDeploymentId: workerState.deploymentId,
    workerVersionId: workerState.traffic[0].versionId,
  };
}

export type PostPublicationObservation = {
  schemaVersion: 1;
  operation: "observe-staging-published-pair";
  expectedPair: DeploymentPair;
  outcome: "running" | "passed" | "failed";
  attempts: Array<
    | {
        attempt: number;
        elapsedMs: number;
        outcome: "failed";
        diagnostic: ProviderInspectionDiagnostic;
      }
    | { attempt: number; elapsedMs: number; outcome: "passed"; pair: DeploymentPair }
  >;
};

const samePair = (left: DeploymentPair, right: DeploymentPair): boolean =>
  left.netlifyDeployId === right.netlifyDeployId &&
  left.workerDeploymentId === right.workerDeploymentId &&
  left.workerVersionId === right.workerVersionId;

export async function observePublishedStagingPair(
  expectedPair: DeploymentPair,
  inspect: (deadlineAt: number) => Promise<DeploymentPair>,
  save: (record: PostPublicationObservation) => Promise<void>,
  dependencies: {
    now?: () => number;
    wait?: (milliseconds: number) => Promise<void>;
    budgetMs?: number;
    maxAttempts?: number;
  } = {},
): Promise<DeploymentPair> {
  const now = dependencies.now ?? (() => performance.now());
  const wait =
    dependencies.wait ??
    ((milliseconds: number) => new Promise<void>((done) => setTimeout(done, milliseconds)));
  const budgetMs = dependencies.budgetMs ?? 120_000;
  const maxAttempts = dependencies.maxAttempts ?? 30;
  if (
    !Number.isSafeInteger(budgetMs) ||
    budgetMs < 1 ||
    !Number.isSafeInteger(maxAttempts) ||
    maxAttempts < 1 ||
    maxAttempts > 60
  ) {
    throw new Error("Postpublication observation options are invalid.");
  }
  const startedAt = now();
  const deadlineAt = startedAt + budgetMs;
  const record: PostPublicationObservation = {
    schemaVersion: 1,
    operation: "observe-staging-published-pair",
    expectedPair,
    outcome: "running",
    attempts: [],
  };
  let lastError: ProviderInspectionError | undefined;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      const pair = await inspect(deadlineAt);
      if (!samePair(pair, expectedPair)) {
        throw new ProviderInspectionError({
          provider: "pair",
          operation: "expectedPair",
          classification: "mismatch",
        });
      }
      if (now() > deadlineAt) {
        throw new ProviderInspectionError({
          provider: "pair",
          operation: "expectedPair",
          classification: "assertion",
          assertion: "observation-deadline",
        });
      }
      record.outcome = "passed";
      record.attempts.push({
        attempt,
        elapsedMs: Math.max(0, Math.floor(now() - startedAt)),
        outcome: "passed",
        pair,
      });
      try {
        await save(record);
      } catch (error) {
        throw new RehearsalObservationCheckpointError(error);
      }
      return pair;
    } catch (error) {
      if (error instanceof RehearsalObservationCheckpointError) throw error;
      lastError =
        error instanceof ProviderInspectionError
          ? error
          : new ProviderInspectionError(
              {
                provider: "pair",
                operation: "expectedPair",
                classification: "assertion",
                assertion: "provider-policy",
              },
              error,
            );
      const elapsedMs = Math.max(0, Math.floor(now() - startedAt));
      const exhausted = now() >= deadlineAt || attempt === maxAttempts;
      record.outcome = exhausted ? "failed" : "running";
      record.attempts.push({
        attempt,
        elapsedMs,
        outcome: "failed",
        diagnostic: lastError.diagnostic,
      });
      try {
        await save(record);
      } catch (saveError) {
        throw new RehearsalObservationCheckpointError(saveError);
      }
      if (exhausted) throw new ProviderInspectionError(lastError.diagnostic, lastError);
      await wait(Math.min(2_000, Math.max(0, deadlineAt - now())));
    }
  }
  throw new ProviderInspectionError(lastError!.diagnostic, lastError);
}

// The parser intentionally has no production or configuration override.
export function parseRehearsalArguments(args: readonly string[], cwd: string) {
  const { values } = parseArgs({
    args,
    strict: true,
    allowPositionals: false,
    tokens: true,
    options: {
      artifacts: { type: "string" },
      output: { type: "string" },
      "confirm-external-smoke": { type: "boolean" },
      capture: { type: "boolean" },
      json: { type: "boolean" },
    },
  });
  if (
    !values.artifacts ||
    !values.output ||
    values["confirm-external-smoke"] !== true ||
    values.capture !== true
  )
    throw new Error("Rehearsal requires explicit smoke and screenshot opt-in.");
  return {
    artifactDirectory: resolve(cwd, values.artifacts),
    reportDirectory: resolve(cwd, values.output),
  };
}

export async function runRehearsalCli(args: readonly string[], repositoryRoot: string) {
  const input = { ...parseRehearsalArguments(args, process.cwd()), repositoryRoot };
  const record = await readReleaseJson(
    resolve(input.artifactDirectory, "prepared-release.json"),
    preparedReleaseSchema,
  );
  if (record.source.environment !== "staging")
    throw new Error("Only staging rehearsal is supported.");
  const { source, configuration } = await verifyArtifactSource(
    repositoryRoot,
    record.source.candidate,
    "staging",
  );
  if (JSON.stringify(source) !== JSON.stringify(record.source))
    throw new Error("Candidate evidence differs.");
  const target = configuration.environments.staging;
  const production = configuration.environments.production;
  if (
    !target.netlify ||
    !target.cloudflare ||
    !production.netlify ||
    !production.cloudflare ||
    target.netlify.siteId === production.netlify.siteId ||
    target.cloudflare.workerName === production.cloudflare.workerName
  )
    throw new Error("Distinct staging targets are required.");
  const appTarget = target.netlify;
  const workerTarget = target.cloudflare;
  const netlify = {
    artifactDirectory: resolve(input.artifactDirectory, "netlify"),
    inventorySha256: record.artifacts.netlify.sha256,
    inventory: (await readBoundedJson(
      resolve(input.artifactDirectory, "netlify/inventory.json"),
      1024 * 1024,
      () => new Error("Invalid artifact inventory."),
    )) as NetlifyArtifactInventory,
  };
  const worker = {
    artifactDirectory: resolve(input.artifactDirectory, "worker"),
    manifestSha256: record.artifacts.worker.sha256,
    manifest: (await readBoundedJson(
      resolve(input.artifactDirectory, "worker/worker-artifact.json"),
      1024 * 1024,
      () => new Error("Invalid artifact manifest."),
    )) as WorkerArtifactManifest,
  };
  const workerInput = {
    repositoryRoot,
    artifactDirectory: worker.artifactDirectory,
    environment: "staging" as const,
    productionWorkerName: production.cloudflare.workerName,
    target: workerTarget,
    sourceConfigSha256: artifactHash(
      await readFile(resolve(repositoryRoot, workerTarget.wranglerConfigPath)),
    ),
  };
  await verifyNetlifyArtifacts(netlify);
  await verifyWorkerArtifacts(workerInput, worker);
  const origin = appTarget.expectedNonSecretVariables.PUBLIC_BASE_URL;
  const inspect = () => inspectStagingDeploymentPair(repositoryRoot, configuration);
  let eventIndex = 0;
  const checkpoint = async (value: unknown) => {
    const path = resolve(
      input.reportDirectory,
      `provider-${String(++eventIndex).padStart(3, "0")}.json`,
    );
    await createAtomicJsonStore<unknown>(
      path,
      1024 * 1024,
      () => new Error("Cannot persist provider checkpoint."),
    ).save(value);
  };
  const observationStore = createAtomicJsonStore<PostPublicationObservation>(
    resolve(input.reportDirectory, "postpublish-observation.json"),
    1024 * 1024,
    () => new Error("Cannot persist postpublication observation evidence."),
  );
  const netlifyDependencies = {
    client: await createAuthenticatedNetlifyDeploymentClient(repositoryRoot),
    checkpoint,
  };
  const workerDependencies = {
    transport: createCloudflareWorkerFetchTransport({
      resolveAccessToken: createWranglerAccessTokenResolver({
        repositoryRoot,
        workingDirectory: worker.artifactDirectory,
      }),
    }),
    checkpoint,
  };
  let baseline: DeploymentPair | undefined;
  let held: HeldNetlifyDeployment | undefined;
  let upload: UploadedStagingWorkerVersion | undefined;
  const netlifyInput = () => {
    if (!baseline) throw new Error("Missing baseline.");
    return {
      environment: "staging" as const,
      siteId: appTarget.siteId,
      accountId: appTarget.accountId,
      origin,
      productionSiteId: production.netlify!.siteId,
      baselineDeployId: baseline.netlifyDeployId,
      candidate: record.source.candidate,
      preparation: record,
    };
  };
  const workerRelease = () => {
    if (!baseline) throw new Error("Missing baseline.");
    return {
      artifactInput: workerInput,
      prepared: worker,
      expectedBaselineDeploymentId: baseline.workerDeploymentId,
      migrationPolicy: {
        artifactTag: "v1" as const,
        expectedCurrentTag: "v1" as const,
        change: "none" as const,
      },
    };
  };
  const smoke = async (phase: string) => {
    const result = await runCollaborationSmoke(
      {
        environment: "staging",
        origin,
        capture: true,
        configPath: resolve(repositoryRoot, "scripts/release/environments.json"),
        configSource: "default",
      },
      configuration,
    );
    await writeFile(
      resolve(input.reportDirectory, `${phase}.json`),
      `${JSON.stringify(result)}\n`,
      { flag: "wx", mode: 0o600 },
    );
    return result.outcome === "passed";
  };
  const git = await runCommand("git", ["rev-parse", "--git-common-dir"], {
    cwd: repositoryRoot,
    env: artifactGitEnvironment(),
    inheritEnv: false,
  });
  if (git.exitCode !== 0) throw new Error("Cannot establish staging lock.");
  return withRehearsalGuard(
    resolve(repositoryRoot, git.stdout.trim(), "release-staging"),
    record.source.candidate,
    input.reportDirectory,
    () =>
      rehearsePreparedRelease(input, {
        inspect: async () => {
          const pair = await inspect();
          baseline ??= pair;
          return pair;
        },
        observePublishedPair: (expectedPair) =>
          observePublishedStagingPair(
            expectedPair,
            (deadlineAt) =>
              inspectStagingDeploymentPair(repositoryRoot, configuration, { deadlineAt }),
            (observation) => observationStore.save(observation),
          ),
        holdNetlify: async () => {
          held = await uploadHeldNetlifyDeployment(
            netlifyInput(),
            netlify,
            {
              functionSchedules: netlify.inventory.functionSchedules,
              functionsConfig: netlify.inventory.functionsConfig,
              functions: Object.fromEntries(
                netlify.inventory.functions.map((entry) => [
                  entry.name,
                  {
                    runtime: entry.runtimeVersion ?? entry.runtime,
                    invocationMode: entry.invocationMode,
                    timeout: entry.timeout,
                  },
                ]),
              ),
            },
            netlifyDependencies,
          );
          await checkpoint(held);
        },
        uploadWorker: async () => {
          upload = await uploadPreparedStagingWorker(workerRelease(), workerDependencies);
          await checkpoint(upload);
        },
        activateWorker: async () => {
          if (!upload) throw new Error("Missing uploaded Worker.");
          const activated = await activatePreparedStagingWorker(
            { ...workerRelease(), upload },
            workerDependencies,
          );
          await checkpoint(activated);
          return activated;
        },
        verifyTransition: () => smoke("transition-smoke"),
        publishNetlify: async () => {
          if (!held) throw new Error("Missing held deployment.");
          const published = await publishHeldNetlifyDeployment(
            netlifyInput(),
            held,
            netlifyDependencies,
          );
          await checkpoint(published);
          return published;
        },
        verifyPair: () => smoke("pair-smoke"),
      }),
  );
}
