import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { parseArgs } from "node:util";
import {
  artifactBuildEnvironment,
  artifactHash,
  verifyArtifactSource,
} from "./artifact-contract.ts";
import { createAtomicJsonStore, readBoundedJson } from "./bootstrap-safety.ts";
import { withRehearsalGuard } from "./rehearsal-guard.ts";
import { runCommand } from "./command.ts";
import { readReleaseJson } from "./files.ts";
import { verifyNetlifyArtifacts, type NetlifyArtifactInventory } from "./netlify-artifacts.ts";
import {
  createAuthenticatedNetlifyDeploymentClient,
  uploadHeldNetlifyDeployment,
  publishHeldNetlifyDeployment,
  type HeldNetlifyDeployment,
} from "./netlify-deployment.ts";
import { preparedReleaseSchema } from "./prepare.ts";
import { inspectCloudflare, inspectNetlify, type ProviderCommandRunner } from "./providers.ts";
import { rehearsePreparedRelease, type DeploymentPair } from "./rehearsal.ts";
import { runCollaborationSmoke } from "./smoke.ts";
import { verifyWorkerArtifacts, type WorkerArtifactManifest } from "./worker-artifacts.ts";
import {
  uploadPreparedStagingWorker,
  activatePreparedStagingWorker,
  createWranglerAccessTokenResolver,
  createCloudflareWorkerFetchTransport,
  type UploadedStagingWorkerVersion,
} from "./worker-release.ts";

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
  const run: ProviderCommandRunner = async (executable, argv, extra) => {
    const result = await runCommand(executable, argv, {
      cwd: repositoryRoot,
      inheritEnv: false,
      env: {
        ...artifactBuildEnvironment(
          appTarget.expectedNonSecretVariables.COLLABORATION_WEBSOCKET_URL,
        ),
        ...extra,
      },
      timeoutMs: 30_000,
    });
    if (result.exitCode !== 0) throw new Error("Provider inspection failed.");
    return result.stdout;
  };
  const inspect = async (): Promise<DeploymentPair> => {
    const [app, workerState] = await Promise.all([
      inspectNetlify(appTarget, run),
      inspectCloudflare(
        {
          ...workerTarget,
          wranglerConfigPath: resolve(repositoryRoot, workerTarget.wranglerConfigPath),
        },
        run,
      ),
    ]);
    if (
      !app.variableScopesMatch ||
      Object.values(app.nonSecretVariables).some(
        (value) => !value.present || !value.matchesExpected,
      ) ||
      Object.values(app.requiredSecrets).some((value) => !value) ||
      Object.values(workerState.nonSecretVariables).some(
        (value) => !value.present || !value.matchesExpected,
      ) ||
      Object.values(workerState.requiredSecrets).some((value) => !value) ||
      workerState.traffic.length !== 1 ||
      workerState.traffic[0].percentage !== 100
    )
      throw new Error("Live configuration verification failed.");
    return {
      netlifyDeployId: app.publishedDeployId,
      workerDeploymentId: workerState.deploymentId,
      workerVersionId: workerState.traffic[0].versionId,
    };
  };
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
  const git = await runCommand("git", ["rev-parse", "--git-common-dir"], { cwd: repositoryRoot });
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
